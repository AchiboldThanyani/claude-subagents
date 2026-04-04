import * as vscode from 'vscode';
import { AgentGraphPanel } from './panels/AgentGraphPanel';
import { Orchestrator } from './orchestrator/Orchestrator';
import { checkClaudeCli } from './orchestrator/AgentRunner';
import { AgentPower, AgentType } from './types';

let orchestrator: Orchestrator;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  orchestrator = new Orchestrator();

  // Warn if claude CLI is not on PATH
  checkClaudeCli().then(ok => {
    if (!ok) {
      vscode.window.showWarningMessage(
        'Claude CLI not found on PATH. Install Claude Code to use this extension.',
        'Learn More'
      ).then(choice => {
        if (choice === 'Learn More') {
          vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/code'));
        }
      });
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.openPanel', () => {
      AgentGraphPanel.create(orchestrator, context.extensionUri).reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.runPlanner', async () => {
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri);
      panel.reveal();

      const task = await vscode.window.showInputBox({
        title: 'Claude Planner',
        prompt: 'Describe the task you want to plan and execute with subagents',
        placeHolder: 'e.g. Refactor the auth module to use JWT tokens',
      });

      if (!task) return;

      orchestrator.runPlanner(task).catch((err: Error) => {
        vscode.window.showErrorMessage(`Planner error: ${err.message}`);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.reviewCode', async () => {
      const editor = vscode.window.activeTextEditor;
      let code: string | undefined;

      if (editor && !editor.selection.isEmpty) {
        code = editor.document.getText(editor.selection);
      } else if (editor) {
        code = editor.document.getText();
      }

      if (!code) {
        const input = await vscode.window.showInputBox({
          title: 'Code Review',
          prompt: 'Paste the code or describe what to review',
        });
        if (!input) return;
        code = input;
      }

      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri);
      panel.reveal();

      const filename = vscode.window.activeTextEditor?.document.fileName ?? 'unknown';
      orchestrator.runDirect(
        'code-review',
        `Review the following code from "${filename}":\n\n\`\`\`\n${code}\n\`\`\``
      ).catch((err: Error) => {
        vscode.window.showErrorMessage(`Review error: ${err.message}`);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.createAgent', async () => {
      const panel = AgentGraphPanel.create(orchestrator, context.extensionUri);
      panel.reveal();

      // Quick multi-step wizard via input boxes
      const name = await vscode.window.showInputBox({
        title: 'New Agent — Step 1/3',
        prompt: 'Agent name',
        placeHolder: 'e.g. Documentation Writer',
      });
      if (!name) return;

      const systemPrompt = await vscode.window.showInputBox({
        title: 'New Agent — Step 2/3',
        prompt: 'System prompt (what this agent does)',
        placeHolder: 'You are a documentation writer...',
      });
      if (!systemPrompt) return;

      const powerItems: vscode.QuickPickItem[] = [
        { label: 'files',    description: 'Read, Write, Edit files', picked: false },
        { label: 'terminal', description: 'Run Bash commands',        picked: false },
        { label: 'web',      description: 'Search the web',           picked: false },
        { label: 'todos',    description: 'Manage todo lists',        picked: false },
      ];

      const selected = await vscode.window.showQuickPick(powerItems, {
        title: 'New Agent — Step 3/3',
        placeHolder: 'Select superpowers (optional)',
        canPickMany: true,
      });

      const powers: AgentPower[] = selected?.map(i => i.label as 'files' | 'terminal' | 'web' | 'todos') ?? [];
      if (powers.length === 0) powers.push('none');

      orchestrator.addCustomAgent({
        name,
        type: 'custom',
        systemPrompt,
        powers,
      });

      vscode.window.showInformationMessage(`Agent "${name}" created! You can now run it from the panel.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.clearGraph', () => {
      orchestrator.clear();
    })
  );
}

export function deactivate(): void {
  orchestrator?.clear();
}
