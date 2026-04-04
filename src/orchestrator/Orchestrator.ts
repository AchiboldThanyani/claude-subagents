import { EventEmitter } from 'events';
import { AgentConfig, AgentNode, AgentStatus, AgentType, ExtToWebMsg } from '../types';
import { runAgent } from './AgentRunner';
import { BUILTIN_AGENTS, PLANNER_AGENT } from './builtinAgents';

function makeId(): string {
  // crypto.randomUUID is available in Node 16+
  return (crypto as unknown as { randomUUID: () => string }).randomUUID?.() ??
    Math.random().toString(36).slice(2);
}

export interface OrchestratorEvents {
  message: (msg: ExtToWebMsg) => void;
  log: (text: string, level: 'info' | 'warn' | 'error') => void;
}

interface PlanTask {
  id: string;
  name: string;
  agentType: AgentType;
  powers: AgentConfig['powers'];
  prompt: string;
  dependsOn: string[];
}

interface Plan {
  summary: string;
  tasks: PlanTask[];
}

/**
 * Core orchestration engine.
 * Manages the agent graph, spawns subagents, handles dependencies.
 */
export class Orchestrator extends EventEmitter {
  private nodes = new Map<string, AgentNode>();
  private abortControllers = new Map<string, AbortController>();
  /** User-created custom agents */
  private customAgents: AgentConfig[] = [];

  // ── Public API ────────────────────────────────────────────────────────────

  getNodes(): AgentNode[] {
    return [...this.nodes.values()];
  }

  getCustomAgents(): AgentConfig[] {
    return [...this.customAgents];
  }

  addCustomAgent(config: Omit<AgentConfig, 'id'>): AgentConfig {
    const agent: AgentConfig = { ...config, id: makeId() };
    this.customAgents.push(agent);
    this.log(`Custom agent "${agent.name}" registered`, 'info');
    return agent;
  }

  clear(): void {
    // cancel everything running
    for (const [id, ctrl] of this.abortControllers) {
      ctrl.abort();
      this.abortControllers.delete(id);
    }
    this.nodes.clear();
    this.emit('message', { type: 'clear' } satisfies ExtToWebMsg);
  }

  cancelAgent(id: string): void {
    this.abortControllers.get(id)?.abort();
  }

  /**
   * Run a named built-in agent type directly (without planning).
   */
  async runDirect(agentType: AgentType, input: string, parentId?: string, model?: string): Promise<AgentNode> {
    const template = BUILTIN_AGENTS.find(a => a.type === agentType) ??
      this.customAgents.find(a => a.type === agentType);

    if (!template) {
      throw new Error(`No agent found for type "${agentType}"`);
    }

    const config: AgentConfig = { ...template, id: makeId(), ...(model ? { model } : {}) };
    return this.spawnAgent(config, input, parentId);
  }

  /**
   * Run a custom agent by ID.
   */
  async runCustom(agentId: string, input: string, parentId?: string): Promise<AgentNode> {
    const config = this.customAgents.find(a => a.id === agentId);
    if (!config) throw new Error(`Custom agent ${agentId} not found`);
    return this.spawnAgent(config, input, parentId);
  }

  /**
   * Full planner flow:
   * 1. Run planner agent → get JSON plan
   * 2. Spawn subagents respecting dependencies
   * 3. Run a summarizer over all results
   */
  async runPlanner(task: string): Promise<void> {
    const plannerId = makeId();
    const plannerConfig: AgentConfig = {
      ...PLANNER_AGENT,
      id: plannerId,
    };

    // Create planner node
    const plannerNode = this.createNode(plannerConfig, task);
    this.updateNode(plannerId, { status: 'running', startTime: Date.now() });

    this.log(`Planner starting: "${task}"`, 'info');

    let planJson = '';
    const ctrl = new AbortController();
    this.abortControllers.set(plannerId, ctrl);

    const result = await runAgent(plannerConfig, task, {
      signal: ctrl.signal,
      onStream: (chunk) => {
        planJson += chunk;
        this.updateNode(plannerId, { streamBuffer: planJson });
      },
    });

    this.abortControllers.delete(plannerId);

    if (!result.success) {
      this.updateNode(plannerId, {
        status: 'error',
        error: result.error,
        endTime: Date.now(),
      });
      this.log(`Planner failed: ${result.error}`, 'error');
      return;
    }

    // Parse the plan JSON
    let plan: Plan;
    try {
      // Extract JSON block from response (might be wrapped in markdown)
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch?.[0] ?? result.output) as Plan;
    } catch (err) {
      this.updateNode(plannerId, {
        status: 'error',
        output: result.output,
        error: 'Failed to parse plan JSON',
        endTime: Date.now(),
      });
      this.log('Failed to parse plan JSON from planner', 'error');
      return;
    }

    this.updateNode(plannerId, {
      status: 'done',
      output: `Plan: ${plan.summary}\n\n${plan.tasks.length} tasks queued.`,
      endTime: Date.now(),
    });

    this.log(`Plan ready: ${plan.summary} (${plan.tasks.length} tasks)`, 'info');

    // Execute tasks respecting dependencies
    await this.executePlan(plan, plannerId);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async executePlan(plan: Plan, parentId: string): Promise<void> {
    // Map plan task IDs → node IDs
    const planIdToNodeId = new Map<string, string>();
    // Track completed plan tasks
    const completed = new Set<string>();
    // Results keyed by plan task ID
    const results = new Map<string, string>();

    // Build initial nodes for all tasks
    for (const task of plan.tasks) {
      const template =
        BUILTIN_AGENTS.find(a => a.type === task.agentType) ??
        this.customAgents.find(a => a.type === task.agentType) ??
        BUILTIN_AGENTS[0]; // fallback to planner template shape

      const config: AgentConfig = {
        ...template,
        id: makeId(),
        name: task.name,
        type: task.agentType,
        powers: task.powers ?? template.powers,
      };

      const node = this.createNode(config, task.prompt, parentId);
      planIdToNodeId.set(task.id, node.id);
    }

    // Wave-based execution — run all tasks whose deps are satisfied
    const remaining = new Set(plan.tasks.map(t => t.id));

    while (remaining.size > 0) {
      // Find tasks ready to run
      const ready = plan.tasks.filter(t =>
        remaining.has(t.id) &&
        t.dependsOn.every(dep => completed.has(dep))
      );

      if (ready.length === 0) {
        // Deadlock — remaining tasks have unsatisfied deps
        this.log('Dependency deadlock — remaining tasks skipped', 'warn');
        break;
      }

      // Run this wave in parallel
      await Promise.all(ready.map(async (task) => {
        remaining.delete(task.id);
        const nodeId = planIdToNodeId.get(task.id)!;
        const node = this.nodes.get(nodeId)!;

        // Inject upstream results into prompt if needed
        let prompt = task.prompt;
        if (task.dependsOn.length > 0) {
          const upstream = task.dependsOn
            .map(dep => `[${dep} result]:\n${results.get(dep) ?? '(no output)'}`)
            .join('\n\n');
          prompt = `${prompt}\n\n---\nContext from prior steps:\n${upstream}`;
        }

        const result = await this.runNodeAgent(node, prompt);
        results.set(task.id, result.output ?? '');
        completed.add(task.id);
      }));
    }

    // Final summarizer
    if (results.size > 0) {
      const summaryInput = [...results.entries()]
        .map(([id, out]) => {
          const task = plan.tasks.find(t => t.id === id);
          return `### ${task?.name ?? id}\n${out}`;
        })
        .join('\n\n');

      await this.runDirect('summarizer', summaryInput, parentId);
    }
  }

  private async spawnAgent(
    config: AgentConfig,
    input: string,
    parentId?: string
  ): Promise<AgentNode> {
    const node = this.createNode(config, input, parentId);
    await this.runNodeAgent(node, input);
    return this.nodes.get(node.id)!;
  }

  private async runNodeAgent(node: AgentNode, input: string): Promise<AgentNode> {
    this.updateNode(node.id, { status: 'running', startTime: Date.now() });

    const ctrl = new AbortController();
    this.abortControllers.set(node.id, ctrl);

    let streamAccum = '';

    const result = await runAgent(node, input, {
      signal: ctrl.signal,
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(node.id, { streamBuffer: streamAccum });
      },
    });

    this.abortControllers.delete(node.id);

    if (ctrl.signal.aborted) {
      this.updateNode(node.id, { status: 'cancelled', endTime: Date.now() });
    } else if (result.success) {
      this.updateNode(node.id, {
        status: 'done',
        output: result.output,
        streamBuffer: undefined,
        endTime: Date.now(),
      });
    } else {
      this.updateNode(node.id, {
        status: 'error',
        error: result.error,
        output: result.output,
        endTime: Date.now(),
      });
    }

    return this.nodes.get(node.id)!;
  }

  private createNode(config: AgentConfig, input: string, parentId?: string): AgentNode {
    const node: AgentNode = {
      ...config,
      status: 'idle',
      input,
      parentId,
      children: [],
    };

    this.nodes.set(node.id, node);

    // Register as child of parent
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) {
        parent.children.push(node.id);
        this.nodes.set(parentId, parent);
      }
    }

    this.emit('message', { type: 'addNode', node } satisfies ExtToWebMsg);

    if (parentId) {
      this.emit('message', { type: 'addEdge', from: parentId, to: node.id } satisfies ExtToWebMsg);
    }

    return node;
  }

  private updateNode(id: string, patch: Partial<AgentNode>): void {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node, patch);
    this.emit('message', { type: 'updateNode', id, patch } satisfies ExtToWebMsg);
  }

  private log(text: string, level: 'info' | 'warn' | 'error'): void {
    this.emit('message', { type: 'log', text, level } satisfies ExtToWebMsg);
  }
}
