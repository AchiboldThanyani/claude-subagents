# Claude Subagents

Orchestrate multiple Claude AI agents directly inside VS Code — plan, code, review, test, document and more, all from a single panel.

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- A Claude Pro subscription or API key

## Features

### Agent Canvas
Visualise your agents as a live graph. Spawn agents, chain them together into pipelines, and watch them work in real time.

### Built-in Agents
- **Planner** — breaks tasks into parallelisable subtasks
- **Coder** — writes and edits code
- **Code Reviewer** — reviews code for bugs and improvements
- **Bug Finder** — finds bugs with file and line references
- **Test Writer** — writes unit and integration tests
- **Docs Writer** — writes JSDoc and documentation
- **Refactor** — improves code structure without changing behaviour
- **Summarizer** — summarises long content
- **Git Commit** — writes commit messages from staged changes
- **PR Description** — writes pull request descriptions
- **Negative Space** — finds what's *missing* from your codebase

### Commander
Natural language orchestration — describe what you want and Commander spawns the right agents automatically.

### Pipeline Builder
Chain agents together into reusable pipelines. Add template nodes to the canvas, connect them, and run the whole pipeline with one click.

### Codebase Constitution
Write a persistent project-wide system prompt (architecture decisions, coding standards, forbidden patterns) that gets injected into every agent run.

### Agent DNA
Configure tone, verbosity, focus and persona per agent type. Make your coder terse, your docs writer formal, your bug finder aggressive.

### Rules Management
Add global or per-agent rules (e.g. "Always write tests", "Never use `any`") that are injected into every agent prompt.

### Knowledge Base
Save agent outputs as reusable knowledge. Relevant entries are automatically injected into future agent runs so agents build on prior work.

### Memory Viewer
Browse Claude's persistent memory files directly in the panel.

## Usage

Open the panel: `Ctrl+Shift+U` (or `Cmd+Shift+U` on Mac)

Right-click any file in the editor for quick access to Review, Test, Docs, Bugs, and Refactor.

## License

MIT
