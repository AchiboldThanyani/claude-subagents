import { EventEmitter } from 'events';
import { AgentConfig, AgentNode, AgentType, EditorContext, ExtToWebMsg } from '../types';
import { runAgent } from './AgentRunner';
import { BUILTIN_AGENTS, PLANNER_AGENT } from './builtinAgents';
import { ContextManager } from '../context/ContextManager';
import { HistoryManager } from '../history/HistoryManager';

function makeId(): string {
  return (crypto as unknown as { randomUUID: () => string }).randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2);
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

export class Orchestrator extends EventEmitter {
  private nodes = new Map<string, AgentNode>();
  private abortControllers = new Map<string, AbortController>();
  private customAgents: AgentConfig[] = [];
  private scheduledJobs = new Map<string, ReturnType<typeof setInterval>>();
  private activeCount = 0;
  history: HistoryManager;

  constructor(historyManager: HistoryManager) {
    super();
    this.history = historyManager;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getNodes(): AgentNode[] { return [...this.nodes.values()]; }
  getCustomAgents(): AgentConfig[] { return [...this.customAgents]; }

  addCustomAgent(config: Omit<AgentConfig, 'id'>): AgentConfig {
    const agent: AgentConfig = { ...config, id: makeId() };
    this.customAgents.push(agent);
    this.log(`Custom agent "${agent.name}" registered`, 'info');
    this.emitAgentList();
    return agent;
  }

  clear(): void {
    for (const [, ctrl] of this.abortControllers) ctrl.abort();
    this.abortControllers.clear();
    this.nodes.clear();
    this.activeCount = 0;
    this.emit('message', { type: 'clear' } satisfies ExtToWebMsg);
    this.emitActiveCount();
  }

  cancelAgent(id: string): void {
    this.abortControllers.get(id)?.abort();
  }

  async runDirect(
    agentType: AgentType,
    input: string,
    parentId?: string,
    model?: string,
    ctx?: EditorContext
  ): Promise<AgentNode> {
    const template = BUILTIN_AGENTS.find(a => a.type === agentType) ??
      this.customAgents.find(a => a.type === agentType);
    if (!template) throw new Error(`No agent found for type "${agentType}"`);
    const config: AgentConfig = { ...template, id: makeId(), ...(model ? { model } : {}) };
    return this.spawnAgent(config, input, parentId, ctx);
  }

  async runCustom(
    agentId: string,
    input: string,
    parentId?: string,
    model?: string,
    ctx?: EditorContext
  ): Promise<AgentNode> {
    const config = this.customAgents.find(a => a.id === agentId);
    if (!config) throw new Error(`Custom agent ${agentId} not found`);
    const finalConfig = model ? { ...config, model } : config;
    return this.spawnAgent(finalConfig, input, parentId, ctx);
  }

  async runPlanner(task: string, ctx?: EditorContext): Promise<void> {
    const plannerConfig: AgentConfig = { ...PLANNER_AGENT, id: makeId() };
    const contextBlock = ctx ? ContextManager.buildContextBlock(ctx) : '';
    const plannerNode = this.createNode(plannerConfig, task, undefined, ctx);
    this.updateNode(plannerNode.id, { status: 'running', startTime: Date.now() });
    this.log(`Planner starting: "${task}"`, 'info');

    const ctrl = new AbortController();
    this.abortControllers.set(plannerNode.id, ctrl);
    this.bumpActive(1);

    let planJson = '';
    const result = await runAgent(plannerConfig, contextBlock + task, {
      signal: ctrl.signal,
      onStream: (chunk) => {
        planJson += chunk;
        this.updateNode(plannerNode.id, { streamBuffer: planJson });
      },
    });

    this.abortControllers.delete(plannerNode.id);
    this.bumpActive(-1);

    if (!result.success) {
      this.updateNode(plannerNode.id, { status: 'error', error: result.error, endTime: Date.now() });
      return;
    }

    let plan: Plan;
    try {
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch?.[0] ?? result.output) as Plan;
    } catch {
      this.updateNode(plannerNode.id, {
        status: 'error', output: result.output,
        error: 'Failed to parse plan JSON', endTime: Date.now(),
      });
      return;
    }

    this.updateNode(plannerNode.id, {
      status: 'done',
      output: `Plan: ${plan.summary}\n\n${plan.tasks.length} tasks queued.`,
      endTime: Date.now(),
    });

    await this.executePlan(plan, plannerNode.id, ctx);
  }

  scheduleAgent(agentType: AgentType, cronExpr: string, input: string): string {
    const jobId = makeId();
    const ms = this.cronToMs(cronExpr);
    const interval = setInterval(() => {
      this.runDirect(agentType, input).catch(err =>
        this.log(`Scheduled agent error: ${err.message}`, 'error')
      );
    }, ms);
    this.scheduledJobs.set(jobId, interval);
    this.log(`Scheduled "${agentType}" every ${ms / 60000}min`, 'info');
    return jobId;
  }

  cancelSchedule(jobId: string): void {
    const interval = this.scheduledJobs.get(jobId);
    if (interval) {
      clearInterval(interval);
      this.scheduledJobs.delete(jobId);
    }
  }

  emitAgentList(): void {
    this.emit('message', {
      type: 'agentList',
      builtins: BUILTIN_AGENTS as Array<Omit<AgentConfig, 'id'>>,
      custom: this.customAgents,
    } satisfies ExtToWebMsg);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async executePlan(plan: Plan, parentId: string, ctx?: EditorContext): Promise<void> {
    const planIdToNodeId = new Map<string, string>();
    const completed = new Set<string>();
    const results = new Map<string, string>();

    for (const task of plan.tasks) {
      const template =
        BUILTIN_AGENTS.find(a => a.type === task.agentType) ??
        this.customAgents.find(a => a.type === task.agentType) ??
        BUILTIN_AGENTS[0];
      const config: AgentConfig = {
        ...template,
        id: makeId(),
        name: task.name,
        type: task.agentType,
        powers: task.powers ?? template.powers,
      };
      const node = this.createNode(config, task.prompt, parentId, ctx);
      planIdToNodeId.set(task.id, node.id);
    }

    const remaining = new Set(plan.tasks.map(t => t.id));

    while (remaining.size > 0) {
      const ready = plan.tasks.filter(t =>
        remaining.has(t.id) && t.dependsOn.every(dep => completed.has(dep))
      );
      if (ready.length === 0) { this.log('Dependency deadlock — skipping remaining', 'warn'); break; }

      await Promise.all(ready.map(async (task) => {
        remaining.delete(task.id);
        const nodeId = planIdToNodeId.get(task.id)!;
        const node = this.nodes.get(nodeId)!;

        let prompt = task.prompt;
        if (task.dependsOn.length > 0) {
          const upstream = task.dependsOn
            .map(dep => `[${dep} result]:\n${results.get(dep) ?? '(no output)'}`)
            .join('\n\n');
          prompt = `${prompt}\n\n---\nContext from prior steps:\n${upstream}`;
        }

        const result = await this.runNodeAgent(node, prompt, ctx);
        results.set(task.id, result.output ?? '');
        completed.add(task.id);
      }));
    }

    if (results.size > 0) {
      const summaryInput = [...results.entries()]
        .map(([id, out]) => `### ${plan.tasks.find(t => t.id === id)?.name ?? id}\n${out}`)
        .join('\n\n');
      await this.runDirect('summarizer', summaryInput, parentId);
    }
  }

  private async spawnAgent(
    config: AgentConfig,
    input: string,
    parentId?: string,
    ctx?: EditorContext
  ): Promise<AgentNode> {
    const node = this.createNode(config, input, parentId, ctx);
    await this.runNodeAgent(node, input, ctx);
    return this.nodes.get(node.id)!;
  }

  private async runNodeAgent(node: AgentNode, input: string, ctx?: EditorContext): Promise<AgentNode> {
    this.updateNode(node.id, { status: 'running', startTime: Date.now() });
    const ctrl = new AbortController();
    this.abortControllers.set(node.id, ctrl);
    this.bumpActive(1);

    // Prepend context block
    const contextBlock = ctx ? ContextManager.buildContextBlock(ctx) : '';
    const fullInput = contextBlock + input;

    let streamAccum = '';
    const result = await runAgent(node, fullInput, {
      signal: ctrl.signal,
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(node.id, { streamBuffer: streamAccum });
      },
    });

    this.abortControllers.delete(node.id);
    this.bumpActive(-1);

    const finalStatus = ctrl.signal.aborted ? 'cancelled'
      : result.success ? 'done' : 'error';

    this.updateNode(node.id, {
      status: finalStatus,
      output: result.output,
      error: result.error,
      streamBuffer: undefined,
      endTime: Date.now(),
    });

    // Save to history
    const n = this.nodes.get(node.id)!;
    this.history.add({
      agentName: node.name,
      agentType: node.type,
      input,
      output: result.output,
      timestamp: Date.now(),
      durationMs: result.durationMs,
      success: result.success,
    });

    return n;
  }

  private createNode(config: AgentConfig, input: string, parentId?: string, ctx?: EditorContext): AgentNode {
    const node: AgentNode = { ...config, status: 'idle', input, parentId, children: [], context: ctx };
    this.nodes.set(node.id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) { parent.children.push(node.id); this.nodes.set(parentId, parent); }
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

  private bumpActive(delta: number): void {
    this.activeCount = Math.max(0, this.activeCount + delta);
    this.emitActiveCount();
  }

  private emitActiveCount(): void {
    this.emit('message', { type: 'activeAgents', count: this.activeCount } satisfies ExtToWebMsg);
  }

  /** Very simple cron-like parser: supports "@daily", "@hourly", "30m", "1h" */
  private cronToMs(expr: string): number {
    if (expr === '@daily')  return 24 * 60 * 60 * 1000;
    if (expr === '@hourly') return 60 * 60 * 1000;
    const m = expr.match(/^(\d+)(m|h|s)$/);
    if (m) {
      const n = parseInt(m[1]);
      if (m[2] === 's') return n * 1000;
      if (m[2] === 'm') return n * 60 * 1000;
      if (m[2] === 'h') return n * 60 * 60 * 1000;
    }
    return 60 * 60 * 1000; // default 1h
  }
}
