# Claude Subagents — Build Documentation

> A VS Code extension that visualises and orchestrates Claude AI subagents for daily developer workflows.
> Built by Achi, powered by Claude Code (Pro subscription — no API key required).

---

## Table of Contents

1. [The Idea](#the-idea)
2. [Architecture Overview](#architecture-overview)
3. [How It Works](#how-it-works)
4. [File Structure](#file-structure)
5. [The Build Journey](#the-build-journey)
6. [Key Technical Decisions](#key-technical-decisions)
7. [Built-in Agents](#built-in-agents)
8. [Features](#features)
9. [How to Build & Install](#how-to-build--install)
10. [Known Limitations](#known-limitations)
11. [What's Next](#whats-next)

---

## The Idea

The goal was simple: **use Claude's subagent capabilities directly inside VS Code**, without needing an Anthropic API key or any paid API plan.

The key insight was that **Claude Code ships as a CLI** (`claude`) that you can call programmatically. Instead of calling the Anthropic API directly, the extension spawns the `claude` CLI as a child process — which authenticates using your existing Claude Pro subscription.

This means:
- No API key needed
- Works on Claude Pro ($20/mo)
- All agents run locally on your machine
- Claude has full access to your workspace files (with permission)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host (Node.js)         │
│                                                             │
│  ┌──────────────┐   ┌─────────────────┐   ┌─────────────┐  │
│  │ Orchestrator │──▶│   AgentRunner   │──▶│ claude CLI  │  │
│  │              │   │  (node-pty PTY) │   │  (Pro auth) │  │
│  └──────┬───────┘   └─────────────────┘   └─────────────┘  │
│         │                                                    │
│  ┌──────▼──────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │  ContextManager │  │HistoryManager│  │AgentGraphPanel │ │
│  │ (file/selection)│  │ (disk cache) │  │  (WebView)     │ │
│  └─────────────────┘  └──────────────┘  └───────┬────────┘ │
└──────────────────────────────────────────────────┼──────────┘
                                                   │ postMessage
                                         ┌─────────▼──────────┐
                                         │   panel.html        │
                                         │  (Canvas graph UI)  │
                                         │  Material Symbols   │
                                         │  Force-directed     │
                                         │  physics layout     │
                                         └────────────────────┘
```

---

## How It Works

### 1. Spawning Claude via PTY

The biggest technical challenge was getting Claude to run non-interactively on a **Claude Pro** plan.

The `claude --print` flag (which enables programmatic JSON output) requires **Claude Max** or API credits. Claude Pro only works in interactive terminal sessions.

**Solution: Use a real pseudo-terminal (PTY)**

We use `@homebridge/node-pty-prebuilt-multiarch` to spawn Claude inside a fake terminal. Claude thinks it's running interactively, so it uses the Pro subscription. The extension then:

1. Spawns Claude in a PTY (120 cols × 30 rows)
2. Waits 4 seconds for the welcome banner to finish
3. Sends the prompt + Enter
4. Waits for 10 seconds of silence (Claude has finished responding)
5. Kills the PTY and returns the cleaned output

```typescript
const term = pty.spawn('cmd.exe', ['/c', 'claude', '--dangerously-skip-permissions', ...args], {
  name: 'xterm-color',
  cols: 120,
  rows: 30,
  env: process.env,
});
```

### 2. Auto-answering Prompts

Claude's interactive mode shows several confirmation prompts that need to be answered automatically:

| Prompt | Answer | Method |
|--------|--------|--------|
| Workspace trust dialog | Enter (option 1 pre-selected) | Detect "trustthisfolder" in output |
| Bypass permissions warning | Down arrow + Enter (option 2) | Detect "bypasspermissions" in output |

```typescript
// Down arrow → select option 2 "Yes, I accept"
term.write('\x1B[B');
setTimeout(() => term.write('\r'), 150);
```

### 3. Context Injection

Every agent automatically receives the current editor context prepended to its prompt:

```
---
# Context

## Project Rules (CLAUDE.md)
[contents of CLAUDE.md if present]

## Workspace
C:\Users\Achi\Projects\myapp

## Active File
src/auth/login.ts (typescript)

## Selected Code
```ts
function login(user, pass) { ... }
```
---

[Your actual prompt here]
```

### 4. The Graph UI

The visualisation uses a **HTML5 Canvas** with a custom force-directed physics engine — no external graph library needed.

Each agent is a node. When an agent spawns a subagent, an edge is drawn. The physics engine:
- Repels nodes from each other (inverse-square force)
- Attracts connected nodes (spring force toward ideal distance of 150px)
- Applies gentle gravity toward the canvas centre
- Damps velocity by 15% each frame

Nodes animate with a pulsing ring while running.

### 5. Agent Orchestration

The **Planner agent** is special — it outputs a JSON plan:

```json
{
  "summary": "Refactor auth module",
  "tasks": [
    { "id": "t1", "agentType": "code-review", "prompt": "...", "dependsOn": [] },
    { "id": "t2", "agentType": "coder", "prompt": "...", "dependsOn": ["t1"] }
  ]
}
```

The Orchestrator then executes tasks in **waves** — all tasks with no unmet dependencies run in parallel. When all tasks complete, a Summarizer agent synthesises the results.

---

## File Structure

```
extension/
├── package.json                    VS Code extension manifest & commands
├── tsconfig.json                   TypeScript config
├── .vscodeignore                   Files excluded from VSIX package
├── .vscode/
│   ├── launch.json                 F5 debug config
│   └── tasks.json                  Build task
└── src/
    ├── types.ts                    All shared TypeScript interfaces
    ├── extension.ts                Entry point — registers all commands
    ├── context/
    │   └── ContextManager.ts       Captures editor state (file, selection, CLAUDE.md)
    ├── history/
    │   └── HistoryManager.ts       Persists agent run history to disk (JSON)
    ├── orchestrator/
    │   ├── AgentRunner.ts          Spawns claude CLI via PTY, parses output
    │   ├── builtinAgents.ts        System prompts for all built-in agent types
    │   └── Orchestrator.ts         Multi-agent workflow engine
    ├── panels/
    │   └── AgentGraphPanel.ts      VS Code WebView host, handles messages
    └── webview/
        └── panel.html              Complete UI: canvas graph, sidebar tabs, modals
```

---

## The Build Journey

### Phase 1 — Scaffolding
Started from scratch in an empty directory. Created `package.json`, `tsconfig.json`, the base TypeScript types, and a minimal extension activation.

### Phase 2 — The API Key Problem
Initially built to use `claude --print --output-format stream-json`. Hit the first wall: **"Credit balance is too low"** — `--print` mode requires API credits or Claude Max, not included in Pro.

### Phase 3 — PTY Solution
Switched to using `node-pty` to spawn Claude in a fake interactive terminal. This tricks Claude into using the Pro subscription. The challenge was timing — had to wait for the welcome banner before sending the prompt, and detect silence to know when Claude had finished.

### Phase 4 — Permission Prompts
Claude kept showing interactive prompts:
- Workspace trust dialog
- `--dangerously-skip-permissions` bypass warning
- Skill confirmation dialogs

Each required detecting the prompt text in raw PTY output (with ANSI codes stripped and whitespace removed since cursor movements replace spaces) and sending the right key sequence.

### Phase 5 — Output Cleaning
Raw PTY output includes ANSI escape codes, spinner animations ("Pollinating…", "Bloviating…"), box-drawing characters, and progress indicators. Built a `cleanOutput()` function using regex patterns to strip UI chrome while preserving real response text.

The tricky part: Claude's actual responses often contain `│` characters (markdown tables) and `─` characters (markdown headings), so the filter had to be precise — only remove lines that are *entirely* decorative.

### Phase 6 — Feature Expansion (v0.2)
Added the full feature set:
- 6 new built-in agents
- Context injection (file, selection, CLAUDE.md)
- History persistence
- Resizable sidebar with drag handle
- Expandable output modal
- Memory visualiser (reads `~/.claude/projects/*/memory/`)
- Usage dashboard with bar charts and timeline
- Material Symbols icons
- Agent chaining UI
- Scheduled agents
- Status bar spinner

---

## Key Technical Decisions

### Why PTY instead of `--print`?
`--print` mode requires Claude Max ($100/mo) or API credits. PTY mode works with Claude Pro ($20/mo). Trade-off: slower startup (~4s), no structured JSON output.

### Why no bundler (webpack/esbuild)?
The `node-pty` native module requires platform-specific `.node` binaries that don't survive bundling. Shipping the full `node_modules` in the VSIX is simpler and the 10MB size is acceptable.

### Why canvas instead of a graph library (D3, Cytoscape)?
Avoids CDN dependencies (VS Code WebViews restrict external URLs by default). The custom force-directed engine is ~80 lines and gives full control over appearance.

### Why Material Symbols from Google Fonts?
The CSP (Content Security Policy) had to be updated to allow `fonts.googleapis.com` and `fonts.gstatic.com`. The alternative was bundling an icon font locally, but Google Fonts is simpler and the icons are higher quality than emoji.

### Why `cmd.exe /c claude` on Windows?
VS Code's extension host process doesn't inherit the full user PATH. Spawning via `cmd.exe` picks up the user's PATH where `claude.cmd` is installed, avoiding "command not found" errors.

---

## Built-in Agents

| Agent | Type | Powers | Purpose |
|-------|------|--------|---------|
| Planner | `planner` | none | Breaks tasks into parallel subagent plans |
| Code Reviewer | `code-review` | files | Reviews for bugs, security, quality |
| Researcher | `researcher` | web | Searches the web, synthesises findings |
| Coder | `coder` | files, terminal | Writes and applies code changes |
| Summarizer | `summarizer` | none | Condenses content to key points |
| Git Commit Writer | `git-commit` | terminal | Writes conventional commit messages from `git diff` |
| PR Description | `pr-description` | terminal | Writes full PR descriptions from branch diff |
| Test Writer | `test-writer` | files, terminal | Writes tests matching existing framework |
| Bug Finder | `bug-finder` | files, terminal | Systematically hunts for bugs with severity ratings |
| Docs Writer | `docs-writer` | files | Adds JSDoc/docstrings to source files |
| Refactor Agent | `refactor` | files, terminal | Improves structure without changing behaviour |

---

## Features

### Graph Visualisation
- Force-directed physics layout
- Nodes colour-coded by agent type
- Pulsing animation ring while running
- Drag nodes to reposition
- Pan (drag background) and zoom (scroll wheel)
- Click node to inspect in sidebar

### Sidebar
- **Resizable** — drag the left edge (220px–600px)
- **Collapsible** — click `›` to hide, `‹` to restore
- **Detail tab** — node status, input, output, actions
- **Run tab** — pick agent type, model, prompt, context toggle
- **Create tab** — build custom agents with name, system prompt, superpowers
- **Schedule tab** — run agents on intervals (30m, 1h, daily)
- **Memory tab** — visualise `~/.claude/projects/*/memory/` files
- **Usage tab** — run counts, success rate, bar chart, timeline
- **History tab** — all past runs, expandable
- **Log tab** — real-time orchestrator events

### Output Actions
- **Copy** — to clipboard
- **Diff** — opens VS Code diff viewer against original file
- **Insert** — pastes at cursor position
- **Export MD** — opens as Markdown document
- **Expand** — full-screen modal with complete output

### Editor Integration
- Right-click menu: Review Code, Write Tests, Write Docs, Find Bugs, Refactor
- SCM title button: Write Git Commit Message
- Status bar: spinning indicator + active agent count
- `Ctrl+Shift+R` — Review code
- `Ctrl+Shift+B` — Find bugs
- `Ctrl+Shift+U` — Open panel

---

## How to Build & Install

### Prerequisites
- Node.js 18+
- VS Code
- Claude Code CLI installed and logged in (`claude auth login`)

### Build

```bash
git clone https://github.com/AchiboldThanyani/claude-subagents
cd claude-subagents
npm install
npm run compile
npx vsce package --allow-missing-repository
```

### Install

1. Open VS Code
2. Extensions panel (`Ctrl+Shift+X`)
3. `...` menu → **Install from VSIX**
4. Select `claude-subagents-0.2.0.vsix`
5. Reload VS Code

### Open the panel

- `Ctrl+Shift+U`
- Or: Command Palette → **Claude: Open Subagents Panel**
- Or: Right-click in editor → any Claude command

---

## Known Limitations

| Limitation | Cause | Potential Fix |
|------------|-------|---------------|
| ~4s startup per agent | PTY banner wait | Use `--bare` flag to skip banner |
| Output sometimes includes UI chrome | PTY raw output | More precise ANSI parsing |
| No multi-turn conversations | New PTY per run | Session ID persistence with `--resume` |
| Agents don't share context by default | Independent PTYs | Pass context explicitly via prompt |
| Windows-only PATH fix needed | Extension host PATH | Works via `cmd.exe /c claude` |

---

## What's Next

- **Auto-trigger on save** — passive background review
- **Workspace indexer** — one agent that knows your whole codebase
- **Diff apply UI** — accept/reject per change like a code review
- **Agent templates** — save multi-agent pipelines as reusable presets
- **Multi-turn conversations** — continue talking to a completed node
- **Git integration panel** — git status/diff/log inside the panel
- **Voice input** — speak prompts via Web Speech API
- **Agent marketplace** — share agents via `.agents.json` in the repo

---

*April 2026*
