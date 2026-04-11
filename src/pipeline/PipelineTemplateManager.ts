import * as fs from 'fs';
import * as path from 'path';
import { AgentType } from '../types';

export interface PipelineStep {
  agentType: AgentType | string;
  customAgentId?: string;
  prompt?: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  steps: PipelineStep[];
  edges: Array<{ from: number; to: number }>; // indices into steps[]
  createdAt: number;
  updatedAt: number;
}

export class PipelineTemplateManager {
  private templates: PipelineTemplate[] = [];
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'pipelineTemplates.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.templates = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PipelineTemplate[];
    } catch { /* corrupt — start fresh */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.templates, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  private makeId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  getAll(): PipelineTemplate[] {
    return JSON.parse(JSON.stringify(this.templates));
  }

  get(id: string): PipelineTemplate | undefined {
    return this.templates.find(t => t.id === id);
  }

  save_template(name: string, description: string, steps: PipelineStep[], edges: Array<{ from: number; to: number }>): PipelineTemplate {
    const now = Date.now();
    const template: PipelineTemplate = {
      id: this.makeId(),
      name: name.trim(),
      description: description.trim() || undefined,
      steps,
      edges,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.unshift(template);
    this.save();
    return template;
  }

  update(id: string, patch: Partial<Pick<PipelineTemplate, 'name' | 'description' | 'steps' | 'edges'>>): boolean {
    const t = this.templates.find(t => t.id === id);
    if (!t) return false;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.save();
    return true;
  }

  remove(id: string): void {
    this.templates = this.templates.filter(t => t.id !== id);
    this.save();
  }
}
