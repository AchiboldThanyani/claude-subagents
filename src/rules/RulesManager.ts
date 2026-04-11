import * as fs from 'fs';
import * as path from 'path';
import { AgentType } from '../types';

export interface Rule {
  id: string;
  text: string;
  enabled: boolean;
}

export interface RulesStore {
  global: Rule[];
  perAgent: Partial<Record<AgentType, Rule[]>>;
}

export class RulesManager {
  private store: RulesStore = { global: [], perAgent: {} };
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'rules.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.store = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RulesStore;
    } catch { /* corrupt — start fresh */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  private makeId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  getStore(): RulesStore {
    return JSON.parse(JSON.stringify(this.store)); // deep clone
  }

  addGlobal(text: string): Rule {
    const rule: Rule = { id: this.makeId(), text: text.trim(), enabled: true };
    this.store.global.push(rule);
    this.save();
    return rule;
  }

  addForAgent(agentType: AgentType, text: string): Rule {
    if (!this.store.perAgent[agentType]) this.store.perAgent[agentType] = [];
    const rule: Rule = { id: this.makeId(), text: text.trim(), enabled: true };
    this.store.perAgent[agentType]!.push(rule);
    this.save();
    return rule;
  }

  toggle(id: string): void {
    const all = [
      ...this.store.global,
      ...Object.values(this.store.perAgent).flat(),
    ];
    const rule = all.find(r => r.id === id);
    if (rule) { rule.enabled = !rule.enabled; this.save(); }
  }

  remove(id: string): void {
    this.store.global = this.store.global.filter(r => r.id !== id);
    for (const key of Object.keys(this.store.perAgent) as AgentType[]) {
      this.store.perAgent[key] = this.store.perAgent[key]!.filter(r => r.id !== id);
      if (this.store.perAgent[key]!.length === 0) delete this.store.perAgent[key];
    }
    this.save();
  }

  /** Build the rules block to inject into agent prompts */
  buildRulesBlock(agentType?: AgentType): string {
    const globalActive = this.store.global.filter(r => r.enabled);
    const agentActive  = agentType
      ? (this.store.perAgent[agentType] ?? []).filter(r => r.enabled)
      : [];

    if (globalActive.length === 0 && agentActive.length === 0) return '';

    const lines: string[] = ['## Rules\n'];
    if (globalActive.length > 0) {
      lines.push('### Always (all agents)');
      globalActive.forEach(r => lines.push(`- ${r.text}`));
    }
    if (agentActive.length > 0) {
      lines.push(`\n### This agent only`);
      agentActive.forEach(r => lines.push(`- ${r.text}`));
    }
    return lines.join('\n') + '\n\n';
  }
}
