import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EditorContext } from '../types';

/**
 * Gathers editor context: open file, selection, workspace, CLAUDE.md, extra files.
 */
export class ContextManager {
  /**
   * Snapshot the current editor state.
   * Call this at the moment the user triggers an agent.
   */
  static capture(extraFiles: string[] = []): EditorContext {
    const ctx: EditorContext = {};
    const editor = vscode.window.activeTextEditor;
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    ctx.workspaceFolder = wsFolder;

    if (editor) {
      ctx.filePath = editor.document.uri.fsPath;
      ctx.fileName = path.basename(editor.document.uri.fsPath);
      ctx.language = editor.document.languageId;

      if (!editor.selection.isEmpty) {
        ctx.selection = editor.document.getText(editor.selection);
      }

      // Include full file content (cap at 200KB to avoid overwhelming Claude)
      const content = editor.document.getText();
      ctx.fullContent = content.length > 200_000
        ? content.slice(0, 200_000) + '\n\n[... file truncated at 200KB ...]'
        : content;
    }

    // Load CLAUDE.md from workspace root
    if (wsFolder) {
      const claudeMdPath = path.join(wsFolder, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        ctx.claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
      }
    }

    // Extra files dragged in or passed programmatically
    if (extraFiles.length > 0) {
      ctx.extraFiles = extraFiles
        .filter(f => fs.existsSync(f))
        .map(f => ({
          path: f,
          content: fs.readFileSync(f, 'utf8'),
        }));
    }

    return ctx;
  }

  /**
   * Build a context block to prepend to any agent prompt.
   */
  static buildContextBlock(ctx: EditorContext): string {
    const parts: string[] = [];

    if (ctx.claudeMd) {
      parts.push(`## Project Rules (CLAUDE.md)\n${ctx.claudeMd}`);
    }

    if (ctx.workspaceFolder) {
      parts.push(`## Workspace\n${ctx.workspaceFolder}`);
    }

    if (ctx.filePath) {
      parts.push(`## Active File\n${ctx.filePath} (${ctx.language ?? 'unknown'})`);
    }

    if (ctx.selection) {
      parts.push(`## Selected Code\n\`\`\`${ctx.language ?? ''}\n${ctx.selection}\n\`\`\``);
    } else if (ctx.fullContent) {
      parts.push(`## File Contents: ${ctx.fileName}\n\`\`\`${ctx.language ?? ''}\n${ctx.fullContent}\n\`\`\``);
    }

    if (ctx.extraFiles?.length) {
      for (const f of ctx.extraFiles) {
        const ext = path.extname(f.path).slice(1);
        parts.push(`## File: ${f.path}\n\`\`\`${ext}\n${f.content}\n\`\`\``);
      }
    }

    if (parts.length === 0) return '';
    return `---\n# Context\n\n${parts.join('\n\n')}\n\n---\n\n`;
  }
}
