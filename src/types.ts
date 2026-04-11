export type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export type AgentPower =
  | 'files'
  | 'terminal'
  | 'web'
  | 'todos'
  | 'none';

export type AgentType =
  | 'planner'
  | 'code-review'
  | 'researcher'
  | 'coder'
  | 'summarizer'
  | 'git-commit'
  | 'pr-description'
  | 'test-writer'
  | 'bug-finder'
  | 'docs-writer'
  | 'refactor'
  | 'commander'
  | 'negative-space'
  | 'custom';

export interface EditorContext {
  filePath?: string;
  fileName?: string;
  language?: string;
  selection?: string;
  fullContent?: string;
  workspaceFolder?: string;
  claudeMd?: string;        // contents of CLAUDE.md if present
  extraFiles?: Array<{ path: string; content: string }>;
}

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  systemPrompt: string;
  powers: AgentPower[];
  model?: string;
}

export interface HistoryEntry {
  id: string;
  agentName: string;
  agentType: AgentType;
  input: string;
  output: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
}

export interface AgentNode extends AgentConfig {
  status: AgentStatus;
  input?: string;
  output?: string;
  error?: string;
  parentId?: string;
  children: string[];
  startTime?: number;
  endTime?: number;
  streamBuffer?: string;
  context?: EditorContext;
  sessionId?: string;         // claude --session-id, used to --resume later
  turns: number;              // how many messages have been exchanged
  messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }>;
  isTemplate?: boolean;       // true = design-time placeholder, not yet run
  customAgentId?: string;     // for custom agent templates, the source agent id
}

export interface RunResult {
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

export interface MemoryFile {
  name: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown';
  description: string;
  body: string;
  file: string;
}

export interface UsageStats {
  totalRuns: number;
  successRate: number;
  byType: Record<string, { runs: number; avgDuration: number; errors: number }>;
  recentRuns: Array<{ agentType: string; durationMs: number; success: boolean; timestamp: number }>;
}

/** Messages sent from Extension Host → WebView */
export type ExtToWebMsg =
  | { type: 'addNode';       node: AgentNode }
  | { type: 'updateNode';    id: string; patch: Partial<AgentNode> }
  | { type: 'removeNode';    id: string }
  | { type: 'addEdge';       from: string; to: string }
  | { type: 'clear' }
  | { type: 'log';           text: string; level: 'info' | 'warn' | 'error' }
  | { type: 'history';       entries: HistoryEntry[] }
  | { type: 'context';       ctx: EditorContext }
  | { type: 'agentList';     builtins: Array<Omit<AgentConfig,'id'>>; custom: AgentConfig[] }
  | { type: 'activeAgents';  count: number }
  | { type: 'memory';        files: MemoryFile[] }
  | { type: 'usage';         stats: UsageStats }
  | { type: 'rules';         store: import('./rules/RulesManager').RulesStore }
  | { type: 'constitution';  content: string; info: import('./constitution/ConstitutionManager').ConstitutionInfo }
  | { type: 'dna';           store: import('./dna/DNAManager').DNAStore }
  | { type: 'negativeSpace'; findings: NegativeSpaceFinding[]; nodeId: string; status: 'running' | 'done' | 'error'; stream?: string }
  | { type: 'knowledge';         entries: import('./knowledge/KnowledgeManager').KnowledgeEntry[] }
  | { type: 'pipelineTemplates'; templates: import('./pipeline/PipelineTemplateManager').PipelineTemplate[] }
  | { type: 'enhancedPrompt'; original: string; enhanced: string; target: 'run' | 'commander' }
  | { type: 'claudeFeed'; items: ClaudeFeedItem[]; status: 'loading' | 'done' | 'error'; error?: string };

/** Messages sent from WebView → Extension Host */
export type WebToExtMsg =
  | { type: 'runAgent';      agentType: AgentType; input: string; model?: string; useContext?: boolean }
  | { type: 'runCustom';     agentId: string; input: string; model?: string; useContext?: boolean }
  | { type: 'createAgent';   config: Omit<AgentConfig, 'id'> }
  | { type: 'selectNode';    id: string }
  | { type: 'cancelAgent';   id: string }
  | { type: 'clearGraph' }
  | { type: 'ready' }
  | { type: 'applyDiff';     nodeId: string }
  | { type: 'insertInline';  nodeId: string }
  | { type: 'copyOutput';    text: string }
  | { type: 'exportMarkdown'; nodeId: string }
  | { type: 'openHistory' }
  | { type: 'addEdge';       from: string; to: string }
  | { type: 'scheduleAgent'; agentType: AgentType; cronExpr: string; input: string }
  | { type: 'continueConversation'; nodeId: string; message: string }
  | { type: 'requestMemory' }
  | { type: 'requestUsage' }
  | { type: 'addTemplate';       agentType: AgentType; customAgentId?: string; prompt?: string }
  | { type: 'updateTemplatePrompt'; id: string; prompt: string }
  | { type: 'removeTemplate';    id: string }
  | { type: 'runPipeline';       useContext?: boolean; model?: string }
  | { type: 'runCommander';      input: string; model?: string }
  | { type: 'continueCommander'; nodeId: string; message: string }
  | { type: 'requestRules' }
  | { type: 'addRule';           scope: 'global' | 'agent'; agentType?: string; text: string }
  | { type: 'removeRule';        id: string }
  | { type: 'toggleRule';        id: string }
  | { type: 'requestConstitution' }
  | { type: 'saveConstitution';  content: string }
  | { type: 'clearConstitution' }
  | { type: 'runNegativeSpace'; model?: string }
  | { type: 'fixFinding'; finding: NegativeSpaceFinding }
  | { type: 'requestKnowledge' }
  | { type: 'saveKnowledge'; title: string; content: string; tags: string[]; agentType: string; sourceNodeId?: string }
  | { type: 'deleteKnowledge'; id: string }
  | { type: 'requestPipelineTemplates' }
  | { type: 'savePipelineTemplate'; name: string; description: string }
  | { type: 'loadPipelineTemplate'; id: string }
  | { type: 'deletePipelineTemplate'; id: string }
  | { type: 'enhancePrompt'; input: string; target: 'run' | 'commander' }
  | { type: 'requestClaudeFeed' }
  | { type: 'requestDNA' }
  | { type: 'setDNA'; agentType: string; dna: import('./dna/DNAManager').AgentDNA }
  | { type: 'clearDNA'; agentType: string };

export interface ClaudeFeedItem {
  title: string;
  date: string;
  summary: string;
  url: string;
}

export interface NegativeSpaceFinding {
  category: 'missing-tests' | 'missing-docs' | 'missing-error-handling' | 'missing-validation' | 'missing-types' | 'missing-comments' | 'other';
  title: string;
  file?: string;
  severity: 'high' | 'medium' | 'low';
  suggestion: string;
  fixAgent?: AgentType;
  fixInput?: string;
}

export interface ClaudeJsonResult {
  type: 'result';
  subtype: 'success' | 'error_during_execution';
  is_error: boolean;
  result: string;
  duration_ms: number;
  session_id: string;
  num_turns: number;
}

export const POWER_TOOLS: Record<AgentPower, string[]> = {
  files:    ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  terminal: ['Bash'],
  web:      ['WebFetch', 'WebSearch'],
  todos:    ['TodoWrite'],
  none:     [],
};
