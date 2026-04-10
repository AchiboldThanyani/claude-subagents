import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CONSTITUTION_FILENAME = 'constitution.md';
const CLAUDE_DIR = '.claude';

export interface ConstitutionInfo {
  path: string;
  isWorkspace: boolean;
  hasContent: boolean;
  charCount: number;
}

export const CONSTITUTION_TEMPLATE = `# Codebase Constitution

## Architecture Overview
<!-- Describe the high-level structure of this project -->

## Coding Standards
<!-- Language, formatting, naming conventions, etc. -->

## Patterns to Follow
<!-- Design patterns, abstractions, or idioms used in this codebase -->

## Patterns to Avoid
<!-- Anti-patterns, forbidden approaches, things that have burned you before -->

## Key Decisions
<!-- Important architectural or technical decisions and why they were made -->

## Team Conventions
<!-- PR process, commit style, review expectations, etc. -->
`;

export class ConstitutionManager {
  private workspacePath: string | undefined;
  private globalPath: string;

  constructor(globalStorageDir: string) {
    this.globalPath = path.join(globalStorageDir, CONSTITUTION_FILENAME);
    this.workspacePath = this.detectWorkspacePath();
  }

  private detectWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return path.join(folders[0].uri.fsPath, CLAUDE_DIR, CONSTITUTION_FILENAME);
  }

  /** Refresh workspace path (call when workspace changes) */
  refreshWorkspace(): void {
    this.workspacePath = this.detectWorkspacePath();
  }

  /** Active path: workspace-local if available, else global */
  get activePath(): string {
    return this.workspacePath ?? this.globalPath;
  }

  get isWorkspaceScoped(): boolean {
    return this.workspacePath !== undefined;
  }

  read(): string {
    const p = this.activePath;
    if (!fs.existsSync(p)) return '';
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  }

  write(content: string): void {
    const p = this.activePath;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    } catch { /* non-fatal */ }
  }

  clear(): void {
    const p = this.activePath;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* non-fatal */ }
    }
  }

  /** Build the block to prepend to agent prompts */
  buildConstitutionBlock(): string {
    const text = this.read().trim();
    if (!text) return '';
    return `## Codebase Constitution\n\n${text}\n\n---\n\n`;
  }

  getInfo(): ConstitutionInfo {
    const text = this.read();
    return {
      path: this.activePath,
      isWorkspace: this.isWorkspaceScoped,
      hasContent: text.trim().length > 0,
      charCount: text.length,
    };
  }
}
