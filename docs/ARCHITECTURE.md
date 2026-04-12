# Claude Subagents — Architecture & How It Works

## Overview

Claude Subagents is a VS Code extension that lets you run Claude AI agents directly inside your editor — no API key, no cloud dashboard. It drives the `claude` CLI (Claude Code) as a subprocess, routes agent output to a visual graph panel, and persists configuration across sessions.

The core idea: instead of typing prompts into a chat window, you pick an agent type (code reviewer, bug finder, coder, etc.), it runs `claude` under the hood with the right tools enabled, and the output appears live in a node graph alongside your editor.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                               │
│                                                                 │
│  extension.ts          — activates the extension, registers    │
│                          all VS Code commands                   │
│                                                                 │
│  AgentGraphPanel.ts    — owns the WebviewPanel, bridges        │
│                          messages between UI and Orchestrator  │
│                                                                 │
│  Orchestrator.ts       — runs agents, tracks nodes, manages    │
│                          pipelines, Commander, planner         │
│                                                                 │
│  AgentRunner.ts        — spawns `claude` CLI via PTY,          │
│                          streams output, handles timeouts      │
│                                                                 │
│  Managers (stateful, persisted to globalStorageUri):           │
│    HistoryManager      — agent run history (JSON)              │
│    RulesManager        — global + per-agent rules (JSON)       │
│    ConstitutionManager — project-wide system prompt (markdown) │
│    DNAManager          — per-agent tone/verbosity/focus (JSON) │
│    KnowledgeManager    — saved agent outputs (JSON)            │
│    PipelineTemplateManager — named pipeline templates (JSON)   │
│    ContextManager      — captures current editor state         │
└─────────────────────────────────────────────────────────────────┘
              │  postMessage / onDidReceiveMessage
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  WebView (panel.html — single HTML/JS/CSS file)                 │
│                                                                 │
│  Canvas graph          — draws agent nodes + edges             │
│  Sidebar tabs          — Detail, Run, Create, History,         │
│                          Memory, Usage, Rules, Constitution,   │
│                          DNA, Knowledge, Schedule, Log         │
│  Overlays              — Commander, Negative Space, Feed,      │
│                          Pipeline Templates, Enhance, Preview  │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Execution Engine: AgentRunner

This is the most important file to understand. Every agent run goes through `runAgent()` in [src/orchestrator/AgentRunner.ts](../src/orchestrator/AgentRunner.ts).

### How it works

The `claude` CLI is a TUI (terminal UI) application — it expects a real terminal, not just stdin/stdout. So instead of spawning it as a normal child process, the extension spawns it inside a **pseudo-terminal (PTY)** using the `node-pty` library.

```
node-pty spawns a PTY
  → PTY runs: claude --dangerously-skip-permissions --system-prompt "..." --allowedTools "Read,Write,Edit,..."
  → Claude starts, prints its startup UI
  → After ~4 seconds (startup delay), the runner writes the user's prompt into the PTY
  → Claude processes the prompt, uses tools, streams output back through the PTY
  → The runner reads raw PTY data, strips ANSI codes and UI noise, streams cleaned text to the UI
  → Silence timeout fires after 45s idle or 60s during tool use → runner kills the PTY and resolves
```

### Key flags passed to `claude`

| Flag | Purpose |
|------|---------|
| `--dangerously-skip-permissions` | Skips the interactive permission dialogs for tool use |
| `--system-prompt "<text>"` | Injects the agent's system prompt |
| `--allowedTools "Read,Write,..."` | Restricts which tools the agent can use (maps from `powers`) |
| `--model <id>` | Optional model override |
| `--session-id <uuid>` | Assigns a session ID so conversations can be continued |
| `--resume <session-id>` | Resumes a previous conversation turn |

### Powers → Tools mapping

Defined in [src/types.ts](../src/types.ts):

```typescript
const POWER_TOOLS = {
  files:    ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  terminal: ['Bash'],
  web:      ['WebFetch', 'WebSearch'],
  todos:    ['TodoWrite'],
  none:     [],
};
```

An agent with `powers: ['files', 'terminal']` gets `--allowedTools Read,Write,Edit,Glob,Grep,Bash`.

### Output cleaning

The PTY dumps everything: ANSI escape codes, spinner animations, Claude's startup banner, keyboard shortcut hints, thinking labels, and the actual response. Two cleanup passes are applied:

- **Stream chunks** (`cleanStreamChunk`): aggressive — strips all the loading/thinking noise so only real content reaches the UI in real time
- **Final output** (`cleanOutput`): conservative — strips obvious junk but preserves the full response content

### Timeout strategy

Three timers run concurrently:

1. **Silence idle timer** (45s): resets every time data arrives. Fires when Claude has been quiet for 45 seconds.
2. **Tool use timer** (60s): same but longer — tool calls (file reads, bash, web) can legitimately take longer.
3. **Hard timeout** (10 minutes): unconditional kill, no exceptions.

---

## Orchestrator

[src/orchestrator/Orchestrator.ts](../src/orchestrator/Orchestrator.ts) is the brain. It:

- Maintains the **node graph** (`Map<id, AgentNode>`) — each agent run is a node
- Runs agents concurrently using `runAgent`, tracking `AbortController` per node
- Assembles the **full prompt** for each run by stacking blocks in this order:
  ```
  ConstitutionBlock + DNABlock + RulesBlock + KnowledgeBlock + ContextBlock + UserInput
  ```
- Emits `ExtToWebMsg` events that the panel relays to the webview
- Handles special flows: Planner → parallel subtasks, Commander → parse actions JSON, Negative Space → parse findings block, Pipeline → sequential/parallel node execution

### Prompt assembly

Every agent run injects layered context before the user's input:

```
┌─ Constitution ────────────────────────────────────────┐
│  Project-wide rules from .claude/constitution.md      │
├─ DNA ─────────────────────────────────────────────────┤
│  Tone, verbosity, focus for this specific agent type  │
├─ Rules ────────────────────────────────────────────────┤
│  Global rules + rules scoped to this agent type       │
├─ Knowledge ────────────────────────────────────────────┤
│  Top 3 relevant saved outputs from Knowledge Base     │
├─ Context ──────────────────────────────────────────────┤
│  Active file path, language, selection, CLAUDE.md     │
└─ User Input ───────────────────────────────────────────┘
```

### Node lifecycle

```
createNode()          → status: 'idle'
updateNode()          → status: 'running', startTime
  runAgent() streams  → updateNode({ streamBuffer })  [real-time]
runAgent() resolves   → updateNode({ status: 'done'|'error', output })
history.add()         → persisted to agent-history.json
```

---

## Message Protocol

Communication between the Extension Host and the WebView uses VS Code's `postMessage` API. All messages are typed in [src/types.ts](../src/types.ts).

### Extension → WebView (`ExtToWebMsg`)

| Type | Payload | When sent |
|------|---------|-----------|
| `addNode` | `AgentNode` | Agent starts |
| `updateNode` | `id, Partial<AgentNode>` | Any state change |
| `removeNode` | `id` | Node deleted |
| `addEdge` | `from, to` | Pipeline link created |
| `clear` | — | Graph cleared |
| `log` | `text, level` | Internal log line |
| `history` | `HistoryEntry[]` | On panel ready |
| `context` | `EditorContext` | On editor focus change |
| `agentList` | builtins + custom | On panel ready |
| `memory` | `MemoryFile[]` | On panel ready |
| `usage` | `UsageStats` | On panel ready |
| `rules` | `RulesStore` | On panel ready |
| `constitution` | `content, info` | On panel ready |
| `dna` | `DNAStore` | On panel ready |
| `knowledge` | `KnowledgeEntry[]` | On panel ready |
| `pipelineTemplates` | `PipelineTemplate[]` | On panel ready |
| `negativeSpace` | `findings, status, stream` | During/after NS scan |
| `enhancedPrompt` | `original, enhanced, target` | After enhancement |
| `promptPreview` | `preview, agentName` | After preview request |
| `claudeFeed` | `items, status` | During/after feed load |

### WebView → Extension (`WebToExtMsg`)

| Type | What it triggers |
|------|-----------------|
| `runAgent` | Direct agent run |
| `runCustom` | Custom agent run |
| `cancelAgent` | Abort a running agent |
| `continueConversation` | Follow-up turn on a node |
| `runCommander` | Commander agent |
| `continueCommander` | Follow-up turn on Commander |
| `runPipeline` | Execute canvas pipeline |
| `runNegativeSpace` | Negative Space scan |
| `applyDiff` | Open VS Code diff view |
| `insertInline` | Insert output at cursor |
| `exportMarkdown` | Open output as markdown doc |
| `saveKnowledge` | Save to Knowledge Base |
| `enhancePrompt` | AI-rewrite a prompt |
| `previewPrompt` | Show assembled prompt preview |
| `addRule` / `removeRule` / `toggleRule` | Manage rules |
| `saveConstitution` | Persist constitution |
| `setDNA` / `clearDNA` | Manage agent DNA |
| `savePipelineTemplate` / `loadPipelineTemplate` | Manage pipelines |
| `requestClaudeFeed` | Fetch Anthropic news |

---

## Persistence Layer

All data is stored in VS Code's `globalStorageUri` (a user-specific directory that survives extension updates):

```
globalStorageUri/
  agent-history.json        — up to 500 run history entries
  customAgents.json         — user-created custom agents
  rules.json                — global + per-agent rules
  dna.json                  — per-agent tone/verbosity settings
  knowledge.json            — saved knowledge entries
  pipelineTemplates.json    — named pipeline templates
  constitution.md           — global constitution (fallback)

workspaceFolder/.claude/
  constitution.md           — workspace-local constitution (takes priority)
```

The `ConstitutionManager` prefers the workspace-local path over the global one. Everything else is global only.

---

## The WebView (panel.html)

The entire UI is a single [src/webview/panel.html](../src/webview/panel.html) file (~2900 lines). No build step, no bundler — plain HTML/CSS/JS with inline styles.

### Canvas graph

The agent graph is drawn on an HTML5 `<canvas>` element:

- **Force-directed layout**: each node has a `{x, y, vx, vy}` position. On every frame, nodes repel each other and edges pull connected nodes together. Positions settle naturally.
- **Rendering loop**: `requestAnimationFrame` draws all nodes and edges 60fps.
- **Node appearance**: circle with icon, status ring colour (blue=running, green=done, red=error), and a label below.
- **Edges**: lines between nodes. Pipeline edges are drawn with arrows.
- **Interaction**: drag nodes, scroll to zoom (`camX/Y/Z`), click to select (opens sidebar detail).
- **Dot grid background** + radial gradient overlay for the depth effect.

### Sidebar tabs

Thirteen tabs share a single `#sidebar-body` container. Only one panel is visible at a time (`switchTab(name)`). Each tab has a `#panel-<name>` div that gets shown/hidden.

### Commander overlay

A floating chat interface (`#commander-overlay`) that sits above the canvas. It sends natural language requests to the Commander agent, which replies with a conversational message + a `\`\`\`actions\`\`\`` JSON block. The webview parses that block and dispatches agent runs.

---

## Built-in Agents

Defined in [src/orchestrator/builtinAgents.ts](../src/orchestrator/builtinAgents.ts). Each is an `AgentConfig` minus the `id` (assigned at run time):

| Agent | Type | Powers | What it does |
|-------|------|--------|--------------|
| Planner | `planner` | none | Breaks tasks into parallel subtasks, returns JSON plan |
| Code Reviewer | `code-review` | files | Reviews code for bugs, security, performance |
| Researcher | `researcher` | web | Searches the web, synthesises findings |
| Coder | `coder` | files + terminal | Writes/edits code, runs sanity checks |
| Summarizer | `summarizer` | none | Summarises text, code, or logs |
| Git Commit Writer | `git-commit` | terminal | Writes conventional commit messages |
| PR Description | `pr-description` | terminal | Writes pull request descriptions |
| Test Writer | `test-writer` | files + terminal | Writes tests for existing code |
| Bug Finder | `bug-finder` | files + terminal | Systematically finds bugs by category |
| Docs Writer | `docs-writer` | files | Writes JSDoc/docstring documentation |
| Refactor | `refactor` | files + terminal | Refactors for clarity, runs tests after each change |
| Commander | `commander` | files + terminal + web | Natural language orchestrator, dispatches other agents |
| Negative Space | `negative-space` | files + terminal | Finds *missing* things: tests, docs, error handling |

---

## Special Flows

### Planner flow

1. User triggers "Plan Task"
2. Orchestrator runs the Planner agent with the task description
3. Planner responds with JSON: `{ summary, tasks: [{ id, name, agentType, powers, prompt, dependsOn }] }`
4. Orchestrator parses the JSON, creates a node per task
5. Tasks without `dependsOn` run immediately in parallel; tasks with `dependsOn` wait for their dependencies

### Commander flow

1. User types a natural language request in the Commander overlay
2. Commander agent responds with prose + `\`\`\`actions [...]\`\`\`` block
3. Orchestrator parses the actions array, executes `run` actions as agent nodes
4. Actions can be sequential (`dependsOnPrevious: true`) or parallel

### Negative Space flow

1. User clicks "Negative Space" scan
2. The Negative Space agent explores the workspace with `files` + `terminal` powers
3. It emits a `\`\`\`findings [...]\`\`\`` JSON block in its output
4. Orchestrator parses findings, emits `negativeSpace` message to webview
5. Webview renders findings as cards; each card has a "Fix" button that spawns the appropriate agent

### Pipeline flow

1. User adds template nodes to the canvas (agent placeholders)
2. User draws edges between them (chain mode)
3. "Run Pipeline" button triggers `runPipeline()`
4. Orchestrator walks the template nodes in topological order, running each as a real agent
5. Each agent's output is piped as input to the next node in the chain

---

## Apply Changes: Current State

When an agent (Coder, Refactor) finishes, its output appears in the sidebar. Two actions are available:

**Apply Diff** (`applyDiff` → `claudeSubagents.applyOutput`):
```
Extension creates an untitled buffer with the agent output text
→ Opens vscode.diff(originalFile, untitledBuffer, 'Claude Suggestion')
```
Limitation: this shows the raw output string vs the original file — not a real line-level diff of what actually changed. If the agent wrote files directly via its tools, changes already happened before this button is clicked.

**Insert Inline** (`insertInline` → `claudeSubagents.insertInline`):
```
Pastes the output string at the active cursor position — immediate, no preview
```

The agents with `files` power (Coder, Refactor, Test Writer, Docs Writer) **write files directly** through the Claude CLI. The "Apply Diff" button is primarily useful for agents that *describe* changes in their output text rather than applying them.

---

## How to Build & Run

### Prerequisites

- Node.js 18+
- VS Code 1.85+
- Claude Code CLI installed and on PATH (`claude --version` should work)

### Development

```bash
cd extension
npm install
npm run watch        # TypeScript watch mode — recompiles on save
```

Then in VS Code: press `F5` to launch the Extension Development Host with the extension loaded.

### Package

```bash
npm run package      # produces claude-subagents-<version>.vsix
```

Install locally: `Extensions panel → ⋮ → Install from VSIX`

### Project structure

```
src/
  extension.ts                  — entry point, command registration
  types.ts                      — all shared TypeScript types and message schemas
  orchestrator/
    Orchestrator.ts             — agent execution, node graph, special flows
    AgentRunner.ts              — PTY spawner, output cleaner, timeout logic
    builtinAgents.ts            — system prompts for all built-in agents
  panels/
    AgentGraphPanel.ts          — WebviewPanel, message bridge
  webview/
    panel.html                  — entire UI (canvas graph + sidebar + overlays)
  context/
    ContextManager.ts           — captures editor state, builds context blocks
  history/
    HistoryManager.ts           — run history, JSON persistence
  rules/
    RulesManager.ts             — global + per-agent rules
  constitution/
    ConstitutionManager.ts      — project-wide system prompt
  dna/
    DNAManager.ts               — per-agent tone/verbosity/persona
  knowledge/
    KnowledgeManager.ts         — saved outputs, relevance search
  pipeline/
    PipelineTemplateManager.ts  — named pipeline templates
```

---

## Key Design Decisions

**No API key required.** The extension drives the `claude` CLI rather than calling the Anthropic API directly. This means users authenticate once with `claude` and the extension inherits those credentials automatically.

**PTY over child_process.spawn.** The Claude CLI is a TUI application built with React Ink — it renders to a terminal and expects raw terminal I/O. A regular pipe would break its rendering. The PTY provides a real terminal environment.

**Single HTML file UI.** No bundler, no framework, no build step for the webview. This keeps the toolchain simple and eliminates the webview content security policy headaches that come with `localhost` dev servers.

**Canvas over DOM for the graph.** A DOM-based graph with many nodes gets slow. Canvas stays fast at any node count and gives full control over animations and the visual style.

**Layered prompt assembly.** Constitution → DNA → Rules → Knowledge → Context → Input. Each layer is optional — if a manager has nothing to contribute it returns an empty string. This makes it easy to add new injection layers without changing agent code.

**Silence-based termination.** Rather than waiting for an explicit "done" signal from Claude (which the CLI doesn't emit over PTY), the runner uses silence timers. When the output stream has been quiet for long enough, the run is considered complete. Tool-use activity extends the timer.
