import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Orchestrator } from '../orchestrator/Orchestrator';
import { HistoryManager } from '../history/HistoryManager';
import { ContextManager } from '../context/ContextManager';
import { ExtToWebMsg, MemoryFile, UsageStats, WebToExtMsg } from '../types';
import { BUILTIN_AGENTS } from '../orchestrator/builtinAgents';

export class AgentGraphPanel {
  public static currentPanel: AgentGraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly orchestrator: Orchestrator;
  private readonly history: HistoryManager;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    orchestrator: Orchestrator,
    history: HistoryManager,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.orchestrator = orchestrator;
    this.history = history;

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    const onMsg = (msg: ExtToWebMsg) => this.panel.webview.postMessage(msg);
    this.orchestrator.on('message', onMsg);
    this.disposables.push({ dispose: () => this.orchestrator.off('message', onMsg) });

    this.panel.webview.onDidReceiveMessage(
      (msg: WebToExtMsg) => this.handleWebMsg(msg),
      null,
      this.disposables
    );

    // Push context snapshot on focus change
    vscode.window.onDidChangeActiveTextEditor(() => {
      const ctx = ContextManager.capture();
      this.panel.webview.postMessage({ type: 'context', ctx } satisfies ExtToWebMsg);
    }, null, this.disposables);
  }

  public static create(
    orchestrator: Orchestrator,
    extensionUri: vscode.Uri,
    history: HistoryManager
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
    AgentGraphPanel.currentPanel = new AgentGraphPanel(panel, orchestrator, history, extensionUri);
    return AgentGraphPanel.currentPanel;
  }

  public reveal(): void { this.panel.reveal(vscode.ViewColumn.Two); }

  private async handleWebMsg(msg: WebToExtMsg): Promise<void> {
    switch (msg.type) {

      case 'ready': {
        // Replay graph state
        for (const node of this.orchestrator.getNodes()) {
          this.panel.webview.postMessage({ type: 'addNode', node } satisfies ExtToWebMsg);
          if (node.parentId) {
            this.panel.webview.postMessage({ type: 'addEdge', from: node.parentId, to: node.id } satisfies ExtToWebMsg);
          }
        }
        for (const e of this.orchestrator.getPipelineEdges()) {
          this.panel.webview.postMessage({ type: 'addEdge', from: e.from, to: e.to } satisfies ExtToWebMsg);
        }
        this.orchestrator.emitAgentList();
        this.panel.webview.postMessage({ type: 'history', entries: this.history.getAll() } satisfies ExtToWebMsg);
        this.panel.webview.postMessage({ type: 'memory', files: this.readMemoryFiles() } satisfies ExtToWebMsg);
        this.panel.webview.postMessage({ type: 'usage', stats: this.computeUsage() } satisfies ExtToWebMsg);
        const ctx = ContextManager.capture();
        this.panel.webview.postMessage({ type: 'context', ctx } satisfies ExtToWebMsg);
        break;
      }

      case 'runAgent': {
        const { agentType, input, model, useContext } = msg;
        if (!input.trim()) { vscode.window.showWarningMessage('Please provide input.'); return; }
        const ctx = useContext ? ContextManager.capture() : undefined;
        this.orchestrator.runDirect(agentType, input, undefined, model, ctx)
          .catch((err: Error) => vscode.window.showErrorMessage(`Agent error: ${err.message}`));
        break;
      }

      case 'runCustom': {
        const { agentId, input, model, useContext } = msg;
        if (!input.trim()) { vscode.window.showWarningMessage('Please provide input.'); return; }
        const ctx = useContext ? ContextManager.capture() : undefined;
        this.orchestrator.runCustom(agentId, input, undefined, model, ctx)
          .catch((err: Error) => vscode.window.showErrorMessage(`Agent error: ${err.message}`));
        break;
      }

      case 'createAgent': {
        const created = this.orchestrator.addCustomAgent(msg.config);
        vscode.window.showInformationMessage(`Agent "${created.name}" created!`);
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

      case 'addEdge': {
        const fromNode = this.orchestrator.getNodes().find(n => n.id === msg.from);
        const toNode   = this.orchestrator.getNodes().find(n => n.id === msg.to);
        if (!fromNode || !toNode) return;

        // Template → template: record a pipeline edge (no execution yet)
        if (fromNode.isTemplate && toNode.isTemplate) {
          const ok = this.orchestrator.addPipelineEdge(msg.from, msg.to);
          if (!ok) vscode.window.showWarningMessage('Cannot chain — would create a cycle, duplicate, or self-loop.');
          return;
        }
        // Live → live (legacy behaviour): need fromNode.output
        if (!fromNode.output) {
          vscode.window.showWarningMessage('Chain source has no output yet — wait for it to finish.');
          return;
        }
        this.panel.webview.postMessage({ type: 'addEdge', from: msg.from, to: msg.to } satisfies ExtToWebMsg);
        const ctx = ContextManager.capture();
        const inheritedInput = `Previous step "${fromNode.name}" was asked:\n${fromNode.input ?? ''}\n\nIts output:\n${fromNode.output}\n\n---\nYour task follows from that output.`;
        this.orchestrator.runDirect(toNode.type, inheritedInput, msg.from, undefined, ctx)
          .catch((err: Error) => vscode.window.showErrorMessage(`Pipeline error: ${err.message}`));
        break;
      }

      case 'addTemplate': {
        const ctx = ContextManager.capture();
        try {
          this.orchestrator.addTemplate(msg.agentType, msg.customAgentId, msg.prompt, ctx);
        } catch (err) {
          vscode.window.showErrorMessage(`Add template error: ${(err as Error).message}`);
        }
        break;
      }

      case 'updateTemplatePrompt': {
        this.orchestrator.updateTemplatePrompt(msg.id, msg.prompt);
        break;
      }

      case 'removeTemplate': {
        this.orchestrator.removeTemplate(msg.id);
        break;
      }

      case 'runPipeline': {
        const ctx = msg.useContext ? ContextManager.capture() : undefined;
        this.orchestrator.runPipeline(ctx, msg.model)
          .catch((err: Error) => vscode.window.showErrorMessage(`Pipeline error: ${err.message}`));
        break;
      }

      case 'applyDiff': {
        const node = this.orchestrator.getNodes().find(n => n.id === msg.nodeId);
        if (!node?.output) return;
        const filePath = node.context?.filePath;
        await vscode.commands.executeCommand('claudeSubagents.applyOutput', node.output, filePath);
        break;
      }

      case 'insertInline': {
        const node = this.orchestrator.getNodes().find(n => n.id === msg.nodeId);
        if (!node?.output) return;
        await vscode.commands.executeCommand('claudeSubagents.insertInline', node.output);
        break;
      }

      case 'copyOutput': {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage('Copied to clipboard!');
        break;
      }

      case 'exportMarkdown': {
        const node = this.orchestrator.getNodes().find(n => n.id === msg.nodeId);
        if (!node?.output) return;
        const md = `# ${node.name}\n\n**Type:** ${node.type}\n**Status:** ${node.status}\n\n## Input\n${node.input ?? ''}\n\n## Output\n${node.output}`;
        const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
        break;
      }

      case 'scheduleAgent': {
        this.orchestrator.scheduleAgent(msg.agentType, msg.cronExpr, msg.input);
        vscode.window.showInformationMessage(`Agent "${msg.agentType}" scheduled (${msg.cronExpr})`);
        break;
      }

      case 'continueConversation': {
        const { nodeId, message } = msg;
        if (!message.trim()) return;
        const ctx = ContextManager.capture();
        this.orchestrator.continueConversation(nodeId, message, ctx)
          .catch((err: Error) => vscode.window.showErrorMessage(`Continue error: ${err.message}`));
        break;
      }

      case 'openHistory': {
        this.panel.webview.postMessage({ type: 'history', entries: this.history.getAll() } satisfies ExtToWebMsg);
        break;
      }

      case 'requestMemory': {
        this.panel.webview.postMessage({ type: 'memory', files: this.readMemoryFiles() } satisfies ExtToWebMsg);
        break;
      }

      case 'requestUsage': {
        this.panel.webview.postMessage({ type: 'usage', stats: this.computeUsage() } satisfies ExtToWebMsg);
        break;
      }

      case 'selectNode':
        break;
    }
  }

  private readMemoryFiles(): MemoryFile[] {
    const results: MemoryFile[] = [];
    const homeDir = os.homedir();
    const memoryRoot = path.join(homeDir, '.claude', 'projects');
    if (!fs.existsSync(memoryRoot)) return results;

    try {
      const projects = fs.readdirSync(memoryRoot);
      for (const proj of projects) {
        const memDir = path.join(memoryRoot, proj, 'memory');
        if (!fs.existsSync(memDir)) continue;
        const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
        for (const file of files) {
          const fullPath = path.join(memDir, file);
          const raw = fs.readFileSync(fullPath, 'utf8');
          // Parse frontmatter
          const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
          if (!fm) continue;
          const meta = fm[1];
          const body = fm[2].trim();
          const nameMatch = meta.match(/name:\s*(.+)/);
          const typeMatch = meta.match(/type:\s*(.+)/);
          const descMatch = meta.match(/description:\s*(.+)/);
          const type = (typeMatch?.[1]?.trim() ?? 'unknown') as MemoryFile['type'];
          results.push({
            name: nameMatch?.[1]?.trim() ?? file,
            type,
            description: descMatch?.[1]?.trim() ?? '',
            body,
            file: fullPath,
          });
        }
      }
    } catch { /* non-fatal */ }
    return results;
  }

  private computeUsage(): UsageStats {
    const entries = this.history.getAll();
    const byType: UsageStats['byType'] = {};
    let successes = 0;

    for (const e of entries) {
      if (!byType[e.agentType]) byType[e.agentType] = { runs: 0, avgDuration: 0, errors: 0 };
      const t = byType[e.agentType];
      t.runs++;
      t.avgDuration = (t.avgDuration * (t.runs - 1) + e.durationMs) / t.runs;
      if (!e.success) t.errors++;
      if (e.success) successes++;
    }

    return {
      totalRuns: entries.length,
      successRate: entries.length ? Math.round((successes / entries.length) * 100) : 0,
      byType,
      recentRuns: entries.slice(0, 50).map(e => ({
        agentType: e.agentType,
        durationMs: e.durationMs,
        success: e.success,
        timestamp: e.timestamp,
      })),
    };
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'panel.html');
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      const agentListJson = JSON.stringify(
        BUILTIN_AGENTS.map(a => ({ name: a.name, type: a.type, powers: a.powers }))
      );
      html = html.replace('__BUILTIN_AGENTS__', agentListJson);
      return html;
    }
    return `<!DOCTYPE html><html><body><p style="color:red;">Could not load panel.html.</p></body></html>`;
  }

  public dispose(): void {
    AgentGraphPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
