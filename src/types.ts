export type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export type AgentPower =
  | 'files'      // Read, Write, Edit, Glob, Grep
  | 'terminal'   // Bash
  | 'web'        // WebFetch, WebSearch
  | 'todos'      // TodoWrite
  | 'none';

export type AgentType =
  | 'planner'
  | 'code-review'
  | 'researcher'
  | 'coder'
  | 'summarizer'
  | 'custom';

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  systemPrompt: string;
  powers: AgentPower[];
  model?: string;
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
  /** streaming chunks before full output is ready */
  streamBuffer?: string;
}

export interface RunResult {
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

/** Messages sent from Extension Host → WebView */
export type ExtToWebMsg =
  | { type: 'addNode';    node: AgentNode }
  | { type: 'updateNode'; id: string; patch: Partial<AgentNode> }
  | { type: 'addEdge';    from: string; to: string }
  | { type: 'clear' }
  | { type: 'log';        text: string; level: 'info' | 'warn' | 'error' };

/** Messages sent from WebView → Extension Host */
export type WebToExtMsg =
  | { type: 'runAgent';      agentType: AgentType; input: string; model?: string }
  | { type: 'createAgent';   config: Omit<AgentConfig, 'id'> }
  | { type: 'selectNode';    id: string }
  | { type: 'cancelAgent';   id: string }
  | { type: 'clearGraph' }
  | { type: 'ready' };

/** What the claude CLI returns for --output-format json */
export interface ClaudeJsonResult {
  type: 'result';
  subtype: 'success' | 'error_during_execution';
  is_error: boolean;
  result: string;
  duration_ms: number;
  session_id: string;
  num_turns: number;
}

/** Power → allowed tool names for --allowedTools flag */
export const POWER_TOOLS: Record<AgentPower, string[]> = {
  files:    ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  terminal: ['Bash'],
  web:      ['WebFetch', 'WebSearch'],
  todos:    ['TodoWrite'],
  none:     [],
};
