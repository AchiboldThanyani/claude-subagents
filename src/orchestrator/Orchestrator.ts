import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentConfig, AgentNode, AgentType, EditorContext, ExtToWebMsg } from '../types';
import { runAgent } from './AgentRunner';
import { BUILTIN_AGENTS, PLANNER_AGENT, COMMANDER_AGENT, NEGATIVE_SPACE_AGENT } from './builtinAgents';
import { ContextManager } from '../context/ContextManager';
import { HistoryManager } from '../history/HistoryManager';
import { RulesManager } from '../rules/RulesManager';
import { ConstitutionManager } from '../constitution/ConstitutionManager';
import { DNAManager } from '../dna/DNAManager';
import { KnowledgeManager } from '../knowledge/KnowledgeManager';
import { PipelineTemplateManager } from '../pipeline/PipelineTemplateManager';

function makeId(): string {
  return (crypto as unknown as { randomUUID: () => string }).randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Generate a RFC4122 v4 UUID for claude --session-id */
function makeSessionId(): string {
  if ((crypto as unknown as { randomUUID?: () => string }).randomUUID) {
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  }
  // Fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
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
  private customAgentsFile: string | undefined;
  private pipelineEdges: Array<{ from: string; to: string }> = [];
  history: HistoryManager;
  rules: RulesManager | undefined;
  constitution: ConstitutionManager | undefined;
  dna: DNAManager | undefined;
  knowledge: KnowledgeManager | undefined;
  pipelineTemplates: PipelineTemplateManager | undefined;

  constructor(historyManager: HistoryManager, storageDir?: string) {
    super();
    this.history = historyManager;
    if (storageDir) {
      fs.mkdirSync(storageDir, { recursive: true });
      this.customAgentsFile = path.join(storageDir, 'customAgents.json');
      this.loadCustomAgents();
      this.rules = new RulesManager(storageDir);
      this.constitution = new ConstitutionManager(storageDir);
      this.dna = new DNAManager(storageDir);
      this.knowledge = new KnowledgeManager(storageDir);
      this.pipelineTemplates = new PipelineTemplateManager(storageDir);
    }
  }

  private loadCustomAgents(): void {
    if (!this.customAgentsFile || !fs.existsSync(this.customAgentsFile)) return;
    try {
      const raw = fs.readFileSync(this.customAgentsFile, 'utf8');
      this.customAgents = JSON.parse(raw) as AgentConfig[];
    } catch { /* corrupt file — start fresh */ }
  }

  private saveCustomAgents(): void {
    if (!this.customAgentsFile) return;
    try {
      fs.writeFileSync(this.customAgentsFile, JSON.stringify(this.customAgents, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getNodes(): AgentNode[] { return [...this.nodes.values()]; }
  getCustomAgents(): AgentConfig[] { return [...this.customAgents]; }

  addCustomAgent(config: Omit<AgentConfig, 'id'>): AgentConfig {
    const agent: AgentConfig = { ...config, id: makeId() };
    this.customAgents.push(agent);
    this.saveCustomAgents();
    this.log(`Custom agent "${agent.name}" registered`, 'info');
    this.emitAgentList();
    return agent;
  }

  clear(): void {
    for (const [, ctrl] of this.abortControllers) ctrl.abort();
    this.abortControllers.clear();
    this.nodes.clear();
    this.pipelineEdges = [];
    this.activeCount = 0;
    this.emit('message', { type: 'clear' } satisfies ExtToWebMsg);
    this.emitActiveCount();
  }

  // ── Commander API ─────────────────────────────────────────────────────────

  async runCommander(input: string, ctx?: EditorContext, model?: string): Promise<AgentNode> {
    const config: AgentConfig = { ...COMMANDER_AGENT, id: makeId(), ...(model ? { model } : {}) };
    const node = this.createNode(config, input, undefined, ctx);
    this.updateNode(node.id, { status: 'running', startTime: Date.now() });

    const ctrl = new AbortController();
    this.abortControllers.set(node.id, ctrl);
    this.bumpActive(1);

    const constitutionBlock = this.constitution?.buildConstitutionBlock() ?? '';
    const dnaBlock          = this.dna?.buildDNABlock('commander') ?? '';
    const rulesBlock        = this.rules?.buildRulesBlock('commander') ?? '';
    const knowledgeBlock    = this.knowledge?.buildKnowledgeBlock('commander', input) ?? '';
    const contextBlock      = ctx ? ContextManager.buildContextBlock(ctx) : '';
    let streamAccum = '';

    const result = await runAgent(config, constitutionBlock + dnaBlock + rulesBlock + knowledgeBlock + contextBlock + input, {
      signal: ctrl.signal,
      sessionId: node.sessionId,
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(node.id, { streamBuffer: streamAccum });
      },
    });

    this.abortControllers.delete(node.id);
    this.bumpActive(-1);

    const completedNode = this.nodes.get(node.id)!;
    completedNode.messages.push({ role: 'assistant', text: result.output, timestamp: Date.now() });

    this.updateNode(node.id, {
      status: result.success ? 'done' : 'error',
      output: result.output,
      error: result.error,
      streamBuffer: undefined,
      endTime: Date.now(),
      turns: completedNode.turns + 1,
      messages: completedNode.messages,
    });

    // Parse and execute actions from Commander's response
    if (result.success && result.output) {
      await this.executeCommanderActions(result.output, node.id, ctx);
    }

    this.history.add({
      agentName: config.name,
      agentType: config.type,
      input,
      output: result.output,
      timestamp: Date.now(),
      durationMs: result.durationMs,
      success: result.success,
    });

    return this.nodes.get(node.id)!;
  }

  // ── Negative Space ─────────────────────────────────────────────────────────

  async runNegativeSpace(ctx?: EditorContext, model?: string): Promise<AgentNode> {
    const config: AgentConfig = { ...NEGATIVE_SPACE_AGENT, id: makeId(), ...(model ? { model } : {}) };
    const workspaceFolder = ctx?.workspaceFolder ?? '';
    const input = workspaceFolder
      ? `Analyse the workspace at: ${workspaceFolder}\n\nScan all source files and identify what is missing.`
      : 'Scan the current workspace and identify what is missing.';

    const node = this.createNode(config, input, undefined, ctx);
    this.updateNode(node.id, { status: 'running', startTime: Date.now() });

    const ctrl = new AbortController();
    this.abortControllers.set(node.id, ctrl);
    this.bumpActive(1);

    const constitutionBlock = this.constitution?.buildConstitutionBlock() ?? '';
    const dnaBlock          = this.dna?.buildDNABlock('negative-space') ?? '';
    const rulesBlock        = this.rules?.buildRulesBlock('negative-space') ?? '';
    let streamAccum = '';

    // Emit running state to webview immediately
    this.emit('message', {
      type: 'negativeSpace',
      findings: [],
      nodeId: node.id,
      status: 'running',
      stream: '',
    } satisfies ExtToWebMsg);

    const result = await runAgent(config, constitutionBlock + dnaBlock + rulesBlock + input, {
      signal: ctrl.signal,
      sessionId: node.sessionId,
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(node.id, { streamBuffer: streamAccum });
        this.emit('message', {
          type: 'negativeSpace',
          findings: [],
          nodeId: node.id,
          status: 'running',
          stream: streamAccum,
        } satisfies ExtToWebMsg);
      },
    });

    this.abortControllers.delete(node.id);
    this.bumpActive(-1);

    const finalStatus = result.success ? 'done' : 'error';
    this.updateNode(node.id, {
      status: finalStatus,
      output: result.output,
      error: result.error,
      streamBuffer: undefined,
      endTime: Date.now(),
    });

    // Parse findings from output
    const findings = this.parseNegativeSpaceFindings(result.output);
    this.emit('message', {
      type: 'negativeSpace',
      findings,
      nodeId: node.id,
      status: finalStatus,
      stream: result.output,
    } satisfies ExtToWebMsg);

    this.history.add({
      agentName: config.name,
      agentType: config.type,
      input,
      output: result.output,
      timestamp: Date.now(),
      durationMs: result.durationMs,
      success: result.success,
    });

    return this.nodes.get(node.id)!;
  }

  private parseNegativeSpaceFindings(output: string): import('../types').NegativeSpaceFinding[] {
    const match = output.match(/```findings\s*([\s\S]*?)```/);
    if (!match) return [];
    try {
      return JSON.parse(match[1].trim()) as import('../types').NegativeSpaceFinding[];
    } catch {
      this.log('Negative Space: failed to parse findings block', 'warn');
      return [];
    }
  }

  async continueCommander(nodeId: string, message: string, ctx?: EditorContext): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    if (!node.sessionId) throw new Error(`Node has no session ID`);
    if (node.status === 'running') throw new Error(`Commander is already running`);

    node.messages.push({ role: 'user', text: message, timestamp: Date.now() });
    this.updateNode(nodeId, { status: 'running', startTime: Date.now(), streamBuffer: '', messages: node.messages });

    const ctrl = new AbortController();
    this.abortControllers.set(nodeId, ctrl);
    this.bumpActive(1);

    const constitutionBlock = this.constitution?.buildConstitutionBlock() ?? '';
    const dnaBlock          = this.dna?.buildDNABlock(node.type) ?? '';
    const rulesBlock        = this.rules?.buildRulesBlock(node.type) ?? '';
    const knowledgeBlock    = this.knowledge?.buildKnowledgeBlock(node.type, message) ?? '';
    const contextBlock      = ctx ? ContextManager.buildContextBlock(ctx) : '';
    let streamAccum = '';

    const result = await runAgent(node, constitutionBlock + dnaBlock + rulesBlock + knowledgeBlock + contextBlock + message, {
      signal: ctrl.signal,
      resume: node.sessionId,
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(nodeId, { streamBuffer: streamAccum });
      },
    });

    this.abortControllers.delete(nodeId);
    this.bumpActive(-1);

    const updatedNode = this.nodes.get(nodeId)!;
    updatedNode.messages.push({ role: 'assistant', text: result.output, timestamp: Date.now() });

    this.updateNode(nodeId, {
      status: result.success ? 'done' : 'error',
      output: result.output,
      error: result.error,
      streamBuffer: undefined,
      endTime: Date.now(),
      turns: updatedNode.turns + 1,
      messages: updatedNode.messages,
    });

    if (result.success && result.output) {
      await this.executeCommanderActions(result.output, nodeId, ctx);
    }
  }

  private async executeCommanderActions(output: string, commanderNodeId: string, ctx?: EditorContext): Promise<void> {
    // Extract JSON actions block from Commander's response
    const match = output.match(/```actions\s*([\s\S]*?)```/);
    if (!match) return;

    let actions: Array<{
      action: string;
      type?: AgentType;
      input?: string;
      useContext?: boolean;
      dependsOnPrevious?: boolean;
      cron?: string;
      id?: string;
      text?: string;
    }>;

    try {
      actions = JSON.parse(match[1].trim());
    } catch {
      this.log('Commander: failed to parse actions block', 'warn');
      return;
    }

    let lastNodeId: string | undefined;

    for (const action of actions) {
      if (action.action === 'run' && action.type) {
        // If dependsOnPrevious, wait for the last node to finish first
        if (action.dependsOnPrevious && lastNodeId) {
          await this.waitForNode(lastNodeId);
        }
        const agentCtx = action.useContext ? ctx : undefined;
        const template = BUILTIN_AGENTS.find(a => a.type === action.type) ??
          this.customAgents.find(a => a.type === action.type);
        if (!template) { this.log(`Commander: unknown agent type "${action.type}"`, 'warn'); continue; }
        const config: AgentConfig = { ...template, id: makeId() };
        const childNode = this.createNode(config, action.input ?? '', commanderNodeId, agentCtx);
        // Don't await — let it run, UI shows progress live
        this.runNodeAgent(childNode, action.input ?? '', agentCtx)
          .catch(err => this.log(`Commander child error: ${err.message}`, 'error'));
        lastNodeId = childNode.id;

      } else if (action.action === 'schedule' && action.type && action.cron) {
        this.scheduleAgent(action.type, action.cron, action.input ?? '');
        this.log(`Commander scheduled "${action.type}" (${action.cron})`, 'info');

      } else if (action.action === 'cancel' && action.id) {
        this.cancelAgent(action.id);

      } else if (action.action === 'answer') {
        // Pure reply — no agents to spawn, nothing to do
      }
    }
  }

  private waitForNode(nodeId: string): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        const n = this.nodes.get(nodeId);
        if (!n || n.status === 'done' || n.status === 'error' || n.status === 'cancelled') {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  // ── Template / Pipeline API ────────────────────────────────────────────────

  addTemplate(agentType: AgentType, customAgentId?: string, prompt?: string, ctx?: EditorContext): AgentNode {
    const template =
      BUILTIN_AGENTS.find(a => a.type === agentType) ??
      this.customAgents.find(a => a.id === customAgentId) ??
      this.customAgents.find(a => a.type === agentType);
    if (!template) throw new Error(`No agent found for type "${agentType}"`);

    const config: AgentConfig = { ...template, id: makeId() };
    const node: AgentNode = {
      ...config,
      status: 'idle',
      input: prompt ?? this.defaultPromptFor(agentType, ctx),
      children: [],
      context: ctx,
      turns: 0,
      messages: [],
      isTemplate: true,
      customAgentId,
    };
    this.nodes.set(node.id, node);
    this.emit('message', { type: 'addNode', node } satisfies ExtToWebMsg);
    return node;
  }

  updateTemplatePrompt(id: string, prompt: string): void {
    const node = this.nodes.get(id);
    if (!node || !node.isTemplate) return;
    node.input = prompt;
    this.emit('message', { type: 'updateNode', id, patch: { input: prompt } } satisfies ExtToWebMsg);
  }

  removeTemplate(id: string): void {
    const node = this.nodes.get(id);
    if (!node || !node.isTemplate) return;
    this.nodes.delete(id);
    this.pipelineEdges = this.pipelineEdges.filter(e => e.from !== id && e.to !== id);
    this.emit('message', { type: 'removeNode', id } satisfies ExtToWebMsg);
  }

  addPipelineEdge(from: string, to: string): boolean {
    if (from === to) return false;
    if (this.pipelineEdges.find(e => e.from === from && e.to === to)) return false;
    // Prevent cycles: reject if `from` is reachable from `to`
    const visited = new Set<string>();
    const stack = [to];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return false;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const e of this.pipelineEdges) if (e.from === cur) stack.push(e.to);
    }
    this.pipelineEdges.push({ from, to });
    this.emit('message', { type: 'addEdge', from, to } satisfies ExtToWebMsg);
    return true;
  }

  getPipelineEdges(): Array<{ from: string; to: string }> {
    return [...this.pipelineEdges];
  }

  // ── Pipeline Templates ─────────────────────────────────────────────────────

  saveCurrentPipelineAsTemplate(name: string, description: string): boolean {
    if (!this.pipelineTemplates) return false;
    const templateNodes = [...this.nodes.values()].filter(n => n.isTemplate);
    if (templateNodes.length === 0) return false;

    // Map node ids to step indices
    const idToIndex = new Map<string, number>();
    templateNodes.forEach((n, i) => idToIndex.set(n.id, i));

    const steps = templateNodes.map(n => ({
      agentType: n.type,
      customAgentId: n.customAgentId,
      prompt: n.input,
    }));

    const edges = this.pipelineEdges
      .filter(e => idToIndex.has(e.from) && idToIndex.has(e.to))
      .map(e => ({ from: idToIndex.get(e.from)!, to: idToIndex.get(e.to)! }));

    this.pipelineTemplates.save_template(name, description, steps, edges);
    return true;
  }

  loadPipelineTemplate(templateId: string, ctx?: EditorContext): boolean {
    if (!this.pipelineTemplates) return false;
    const template = this.pipelineTemplates.get(templateId);
    if (!template) return false;

    // Clear existing templates from canvas
    for (const node of [...this.nodes.values()].filter(n => n.isTemplate)) {
      this.nodes.delete(node.id);
      this.emit('message', { type: 'removeNode', id: node.id } satisfies ExtToWebMsg);
    }
    this.pipelineEdges = this.pipelineEdges.filter(e => {
      const from = this.nodes.get(e.from);
      const to   = this.nodes.get(e.to);
      return from && to; // keep only edges between live nodes
    });

    // Recreate template nodes
    const newIds: string[] = [];
    for (const step of template.steps) {
      const agentType = step.agentType as AgentType;
      const node = this.addTemplate(agentType, step.customAgentId, step.prompt, ctx);
      newIds.push(node.id);
    }

    // Recreate edges using new node ids
    for (const edge of template.edges) {
      const fromId = newIds[edge.from];
      const toId   = newIds[edge.to];
      if (fromId && toId) this.addPipelineEdge(fromId, toId);
    }

    return true;
  }

  async runPipeline(ctx?: EditorContext, model?: string): Promise<void> {
    const templates = [...this.nodes.values()].filter(n => n.isTemplate);
    if (templates.length === 0) {
      this.log('Pipeline is empty — add agents to the canvas first', 'warn');
      return;
    }

    // Convert templates → task map, preserving their ids
    const tasks = templates.map(t => ({
      id: t.id,
      templateNodeId: t.id,
      name: t.name,
      type: t.type,
      systemPrompt: t.systemPrompt,
      powers: t.powers,
      prompt: t.input ?? '',
      dependsOn: this.pipelineEdges.filter(e => e.to === t.id).map(e => e.from),
    }));

    const completed = new Set<string>();
    const results = new Map<string, string>();
    const remaining = new Set(tasks.map(t => t.id));

    this.log(`Pipeline starting: ${tasks.length} templates`, 'info');

    while (remaining.size > 0) {
      const ready = tasks.filter(t => remaining.has(t.id) && t.dependsOn.every(d => completed.has(d)));
      if (ready.length === 0) {
        this.log('Pipeline deadlock — check for cycles', 'warn');
        break;
      }

      await Promise.all(ready.map(async (task) => {
        remaining.delete(task.id);
        const node = this.nodes.get(task.templateNodeId)!;

        let prompt = task.prompt;
        if (task.dependsOn.length > 0) {
          // Write upstream results to a temp file so the prompt stays short
          // and doesn't trigger PTY paste-mode issues
          const upstreamParts = task.dependsOn.map(d => {
            const up = tasks.find(t => t.id === d);
            return `## From "${up?.name ?? d}"\n${results.get(d) ?? '(no output)'}`;
          });
          const tmpFile = path.join(os.tmpdir(), `pipeline-ctx-${task.id}.md`);
          fs.writeFileSync(tmpFile, upstreamParts.join('\n\n---\n\n'), 'utf8');
          prompt = `${task.prompt}\n\nIMPORTANT: Read the file "${tmpFile}" — it contains the output from the previous pipeline step(s) that you should use as context.`;
        }

        // Promote template → live node and sync to webview
        node.isTemplate = false;
        node.sessionId = makeSessionId();
        node.messages = [{ role: 'user', text: prompt, timestamp: Date.now() }];
        node.input = prompt;
        this.updateNode(node.id, {
          isTemplate: false,
          sessionId: node.sessionId,
          messages: node.messages,
          input: prompt,
        });

        const cfg: AgentConfig = {
          id: node.id,
          name: node.name,
          type: node.type,
          systemPrompt: node.systemPrompt,
          powers: node.powers,
          ...(model ? { model } : node.model ? { model: node.model } : {}),
        };
        const result = await this.runNodeAgent({ ...node, ...cfg } as AgentNode, prompt, ctx);
        results.set(task.id, result.output ?? '');
        completed.add(task.id);
      }));
    }

    this.log(`Pipeline finished: ${completed.size}/${tasks.length} tasks complete`, 'info');
  }

  private defaultPromptFor(type: AgentType, ctx?: EditorContext): string {
    const file = ctx?.fileName ?? 'the current file';
    switch (type) {
      case 'code-review':   return `Review the code in ${file}`;
      case 'test-writer':   return `Write tests for ${file}`;
      case 'docs-writer':   return `Write documentation for ${file}`;
      case 'bug-finder':    return `Find bugs in ${file}`;
      case 'refactor':      return `Refactor ${file}`;
      case 'git-commit':    return `Write a git commit message for staged changes`;
      case 'pr-description': return `Write a PR description for the current branch`;
      case 'summarizer':    return `Summarize the outputs from previous steps`;
      case 'researcher':    return `Research the topic`;
      case 'coder':         return `Implement the task`;
      default:              return `Run ${type} on ${file}`;
    }
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

  async continueConversation(nodeId: string, message: string, ctx?: EditorContext): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    if (!node.sessionId) throw new Error(`Node has no session ID — cannot resume`);
    if (node.status === 'running') throw new Error(`Agent is already running`);

    // Add user message to history
    node.messages.push({ role: 'user', text: message, timestamp: Date.now() });
    this.updateNode(nodeId, {
      status: 'running',
      startTime: Date.now(),
      streamBuffer: '',
      messages: node.messages,
    });

    const ctrl = new AbortController();
    this.abortControllers.set(nodeId, ctrl);
    this.bumpActive(1);

    const contextBlock = ctx ? ContextManager.buildContextBlock(ctx) : '';
    let streamAccum = '';

    const result = await runAgent(node, contextBlock + message, {
      signal: ctrl.signal,
      resume: node.sessionId,   // --resume keeps full conversation history
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(nodeId, { streamBuffer: streamAccum });
      },
    });

    this.abortControllers.delete(nodeId);
    this.bumpActive(-1);

    // Append assistant reply to messages
    const updatedNode = this.nodes.get(nodeId)!;
    updatedNode.messages.push({ role: 'assistant', text: result.output, timestamp: Date.now() });

    this.updateNode(nodeId, {
      status: result.success ? 'done' : 'error',
      output: result.output,
      error: result.error,
      streamBuffer: undefined,
      endTime: Date.now(),
      turns: updatedNode.turns + 1,
      messages: updatedNode.messages,
    });

    this.history.add({
      agentName: node.name,
      agentType: node.type,
      input: message,
      output: result.output,
      timestamp: Date.now(),
      durationMs: result.durationMs,
      success: result.success,
    });
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

    // Prepend constitution + DNA + rules + knowledge + context block
    const constitutionBlock = this.constitution?.buildConstitutionBlock() ?? '';
    const dnaBlock          = this.dna?.buildDNABlock(node.type) ?? '';
    const rulesBlock        = this.rules?.buildRulesBlock(node.type) ?? '';
    const knowledgeBlock    = this.knowledge?.buildKnowledgeBlock(node.type, input) ?? '';
    const contextBlock      = ctx ? ContextManager.buildContextBlock(ctx) : '';
    const fullInput         = constitutionBlock + dnaBlock + rulesBlock + knowledgeBlock + contextBlock + input;

    let streamAccum = '';
    const result = await runAgent(node, fullInput, {
      signal: ctrl.signal,
      sessionId: node.sessionId,
      onStream: (chunk) => {
        streamAccum += chunk;
        this.updateNode(node.id, { streamBuffer: streamAccum });
      },
    });

    this.abortControllers.delete(node.id);
    this.bumpActive(-1);

    const finalStatus = ctrl.signal.aborted ? 'cancelled'
      : result.success ? 'done' : 'error';

    const completedNode = this.nodes.get(node.id)!;
    completedNode.messages.push({ role: 'assistant', text: result.output, timestamp: Date.now() });

    this.updateNode(node.id, {
      status: finalStatus,
      output: result.output,
      error: result.error,
      streamBuffer: undefined,
      endTime: Date.now(),
      turns: completedNode.turns + 1,
      messages: completedNode.messages,
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
    const node: AgentNode = {
      ...config,
      status: 'idle',
      input,
      parentId,
      children: [],
      context: ctx,
      sessionId: makeSessionId(),
      turns: 0,
      messages: [{ role: 'user', text: input, timestamp: Date.now() }],
    };
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
