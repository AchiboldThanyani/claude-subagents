import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Orchestrator } from '../orchestrator/Orchestrator';
import { ExtToWebMsg, WebToExtMsg } from '../types';
import { BUILTIN_AGENTS } from '../orchestrator/builtinAgents';

export class AgentGraphPanel {
  public static currentPanel: AgentGraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly orchestrator: Orchestrator;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    orchestrator: Orchestrator,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.orchestrator = orchestrator;

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Forward orchestrator messages to the webview
    const onMsg = (msg: ExtToWebMsg) => {
      this.panel.webview.postMessage(msg);
    };
    this.orchestrator.on('message', onMsg);
    this.disposables.push({ dispose: () => this.orchestrator.off('message', onMsg) });

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg: WebToExtMsg) => this.handleWebMsg(msg),
      null,
      this.disposables
    );
  }

  public static create(
    orchestrator: Orchestrator,
    extensionUri: vscode.Uri
  ): AgentGraphPanel {
    if (AgentGraphPanel.currentPanel) {
      AgentGraphPanel.currentPanel.panel.reveal(vscode.ViewColumn.Two);
      return AgentGraphPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeSubagents',
      'Claude Subagents',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')],
      }
    );

    AgentGraphPanel.currentPanel = new AgentGraphPanel(panel, orchestrator, extensionUri);
    return AgentGraphPanel.currentPanel;
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Two);
  }

  public sendMessage(msg: ExtToWebMsg): void {
    this.panel.webview.postMessage(msg);
  }

  private async handleWebMsg(msg: WebToExtMsg): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        // Replay existing nodes so the graph rehydrates after a reload
        for (const node of this.orchestrator.getNodes()) {
          this.panel.webview.postMessage({ type: 'addNode', node } satisfies ExtToWebMsg);
          if (node.parentId) {
            this.panel.webview.postMessage({
              type: 'addEdge', from: node.parentId, to: node.id
            } satisfies ExtToWebMsg);
          }
        }
        break;
      }

      case 'runAgent': {
        const { agentType, input, model } = msg;
        if (!input.trim()) {
          vscode.window.showWarningMessage('Please provide input for the agent.');
          return;
        }
        this.orchestrator.runDirect(agentType, input, undefined, model).catch((err: Error) => {
          vscode.window.showErrorMessage(`Agent error: ${err.message}`);
        });
        break;
      }

      case 'createAgent': {
        const created = this.orchestrator.addCustomAgent(msg.config);
        vscode.window.showInformationMessage(`Agent "${created.name}" created!`);
        // Send updated agent list back
        this.panel.webview.postMessage({
          type: 'log',
          text: `Custom agent "${created.name}" added.`,
          level: 'info',
        } satisfies ExtToWebMsg);
        break;
      }

      case 'cancelAgent': {
        this.orchestrator.cancelAgent(msg.id);
        break;
      }

      case 'clearGraph': {
        this.orchestrator.clear();
        break;
      }

      case 'selectNode':
        // Selection is handled inside the webview; nothing to do on host side
        break;
    }
  }

  private getHtml(): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath, 'src', 'webview', 'panel.html'
    );

    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      // Inject the builtin agent list so the webview can render menus
      const agentListJson = JSON.stringify(
        BUILTIN_AGENTS.map(a => ({ name: a.name, type: a.type, powers: a.powers }))
      );
      html = html.replace('__BUILTIN_AGENTS__', agentListJson);
      return html;
    }

    // Fallback if HTML file not found
    return `<!DOCTYPE html><html><body>
      <p style="color:red;">Could not load panel.html. Run the extension from the correct directory.</p>
    </body></html>`;
  }

  public dispose(): void {
    AgentGraphPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
