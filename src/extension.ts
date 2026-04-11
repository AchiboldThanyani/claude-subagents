import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentGraphPanel } from './panels/AgentGraphPanel';
import { Orchestrator } from './orchestrator/Orchestrator';
import { checkClaudeCli } from './orchestrator/AgentRunner';
import { ContextManager } from './context/ContextManager';
import { HistoryManager } from './history/HistoryManager';
import { AgentPower } from './types';

let orchestrator: Orchestrator;
let statusBarItem: vscode.StatusBarItem;
let historyManager: HistoryManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Init managers
  historyManager = new HistoryManager(context.globalStorageUri.fsPath);
  orchestrator = new Orchestrator(historyManager, context.globalStorageUri.fsPath);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeSubagents.openPanel';
  statusBarItem.text = '$(circuit-board) Claude Agents';
  statusBarItem.tooltip = 'Open Claude Subagents Panel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Update status bar when agents are running
  orchestrator.on('message', (msg) => {
    if (msg.type === 'activeAgents') {
      if (msg.count > 0) {
        statusBarItem.text = `$(sync~spin) Claude Agents (${msg.count} running)`;
      } else {
        statusBarItem.text = '$(circuit-board) Claude Agents';
      }
    }
  });

  // Warn if claude CLI not found
  checkClaudeCli().then(ok => {
    if (!ok) {
      vscode.window.showWarningMessage(
        'Claude CLI not found. Install Claude Code to use this extension.',
        'Learn More'
      ).then(c => {
        if (c === 'Learn More') vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/code'));
      });
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.openPanel', () => {
      AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager).reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.runPlanner', async () => {
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      const task = await vscode.window.showInputBox({
        title: 'Claude Planner',
        prompt: 'Describe the task to plan and execute with subagents',
        placeHolder: 'e.g. Refactor the auth module to use JWT tokens',
      });
      if (!task) return;
      const ctx = ContextManager.capture();
      orchestrator.runPlanner(task, ctx).catch((err: Error) =>
        vscode.window.showErrorMessage(`Planner error: ${err.message}`)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.reviewCode', async () => {
      const editor = vscode.window.activeTextEditor;
      const ctx = ContextManager.capture();
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      const filename = editor?.document.fileName ?? 'unknown';
      const prompt = ctx.selection
        ? `Review this selected code from "${filename}":\n\n\`\`\`\n${ctx.selection}\n\`\`\``
        : `Review the code in "${filename}"`;
      orchestrator.runDirect('code-review', prompt, undefined, undefined, ctx)
        .catch((err: Error) => vscode.window.showErrorMessage(`Review error: ${err.message}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.writeTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Open a file first.'); return; }
      const ctx = ContextManager.capture();
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      orchestrator.runDirect('test-writer', `Write tests for ${ctx.fileName}`, undefined, undefined, ctx)
        .catch((err: Error) => vscode.window.showErrorMessage(`Test writer error: ${err.message}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.writeDocs', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Open a file first.'); return; }
      const ctx = ContextManager.capture();
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      orchestrator.runDirect('docs-writer', `Write documentation for ${ctx.fileName}`, undefined, undefined, ctx)
        .catch((err: Error) => vscode.window.showErrorMessage(`Docs writer error: ${err.message}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.findBugs', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Open a file first.'); return; }
      const ctx = ContextManager.capture();
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      orchestrator.runDirect('bug-finder', `Find bugs in ${ctx.fileName}`, undefined, undefined, ctx)
        .catch((err: Error) => vscode.window.showErrorMessage(`Bug finder error: ${err.message}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.gitCommit', async () => {
      const ctx = ContextManager.capture();
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      orchestrator.runDirect('git-commit', 'Write a git commit message for the current staged changes', undefined, undefined, ctx)
        .catch((err: Error) => vscode.window.showErrorMessage(`Git commit error: ${err.message}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.refactor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Open a file first.'); return; }
      const ctx = ContextManager.capture();
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      const prompt = ctx.selection
        ? `Refactor this selected code:\n\n\`\`\`\n${ctx.selection}\n\`\`\``
        : `Refactor ${ctx.fileName}`;
      orchestrator.runDirect('refactor', prompt, undefined, undefined, ctx)
        .catch((err: Error) => vscode.window.showErrorMessage(`Refactor error: ${err.message}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.createAgent', async () => {
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager);
      panel.reveal();
      const name = await vscode.window.showInputBox({ title: 'New Agent — Step 1/3', prompt: 'Agent name', placeHolder: 'e.g. Documentation Writer' });
      if (!name) return;
      const systemPrompt = await vscode.window.showInputBox({ title: 'New Agent — Step 2/3', prompt: 'System prompt', placeHolder: 'You are a...' });
      if (!systemPrompt) return;
      const powerItems: vscode.QuickPickItem[] = [
        { label: 'files',    description: 'Read, Write, Edit files', picked: false },
        { label: 'terminal', description: 'Run Bash commands',        picked: false },
        { label: 'web',      description: 'Search the web',           picked: false },
        { label: 'todos',    description: 'Manage todo lists',        picked: false },
      ];
      const selected = await vscode.window.showQuickPick(powerItems, { title: 'New Agent — Step 3/3', placeHolder: 'Select superpowers', canPickMany: true });
      const powers = selected?.map(i => i.label as AgentPower) ?? [];
      if (powers.length === 0) powers.push('none');
      orchestrator.addCustomAgent({ name, type: 'custom', systemPrompt, powers });
      vscode.window.showInformationMessage(`Agent "${name}" created!`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.openHistory', () => {
      AgentGraphPanel.create(orchestrator, context.extensionUri, historyManager).reveal();
      // Panel will switch to history tab
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.clearGraph', () => {
      orchestrator.clear();
    })
  );

  // Apply diff — opens output as a diff against the current file
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.applyOutput', async (output: string, filePath?: string) => {
      if (!output) return;
      if (filePath && fs.existsSync(filePath)) {
        const original = vscode.Uri.file(filePath);
        const modified = vscode.Uri.parse(`untitled:${path.basename(filePath)}.suggested`);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(modified, new vscode.Position(0, 0), output);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand('vscode.diff', original, modified, 'Claude Suggestion');
      } else {
        const newDoc = await vscode.workspace.openTextDocument({ content: output });
        await vscode.window.showTextDocument(newDoc);
      }
    })
  );

  // Insert inline at cursor
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.insertInline', async (output: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !output) return;
      editor.edit(editBuilder => {
        editBuilder.insert(editor.selection.active, output);
      });
    })
  );
}

export function deactivate(): void {
  orchestrator?.clear();
  statusBarItem?.dispose();
}
