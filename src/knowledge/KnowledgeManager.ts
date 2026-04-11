import * as fs from 'fs';
import * as path from 'path';
import { AgentType } from '../types';

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  agentType: AgentType | string;
  timestamp: number;
  sourceNodeId?: string;
}

export class KnowledgeManager {
  private entries: KnowledgeEntry[] = [];
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'knowledge.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as KnowledgeEntry[];
    } catch { /* corrupt — start fresh */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  private makeId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  getAll(): KnowledgeEntry[] {
    return JSON.parse(JSON.stringify(this.entries));
  }

  add(entry: Omit<KnowledgeEntry, 'id' | 'timestamp'>): KnowledgeEntry {
    const full: KnowledgeEntry = {
      ...entry,
      id: this.makeId(),
      timestamp: Date.now(),
      tags: entry.tags.map(t => t.toLowerCase().trim()).filter(Boolean),
    };
    this.entries.unshift(full); // newest first
    this.save();
    return full;
  }

  remove(id: string): void {
    this.entries = this.entries.filter(e => e.id !== id);
    this.save();
  }

  /**
   * Find relevant entries for an agent run using keyword overlap.
   * Matches against: tags, agentType, and title words.
   * Returns top N entries scored by relevance.
   */
  findRelevant(agentType: AgentType | string, input: string, topN = 3): KnowledgeEntry[] {
    if (this.entries.length === 0) return [];

    // Build a set of keywords from the input (words > 3 chars, lowercased)
    const inputWords = new Set(
      input.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    );
    inputWords.add(agentType.toLowerCase());

    const scored = this.entries.map(entry => {
      let score = 0;

      // Tag overlap
      for (const tag of entry.tags) {
        if (inputWords.has(tag)) score += 3;
        for (const word of inputWords) {
          if (tag.includes(word) || word.includes(tag)) score += 1;
        }
      }

      // Agent type match
      if (entry.agentType === agentType) score += 2;

      // Title word overlap
      const titleWords = entry.title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      for (const tw of titleWords) {
        if (inputWords.has(tw)) score += 2;
      }

      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(s => s.entry);
  }

  /** Build the knowledge block to inject into prompts */
  buildKnowledgeBlock(agentType: AgentType | string, input: string): string {
    const relevant = this.findRelevant(agentType, input);
    if (relevant.length === 0) return '';

    const lines = ['## Relevant Knowledge\n'];
    for (const e of relevant) {
      lines.push(`### ${e.title}`);
      if (e.tags.length > 0) lines.push(`*Tags: ${e.tags.join(', ')}*`);
      lines.push(e.content.trim());
      lines.push('');
    }
    return lines.join('\n') + '---\n\n';
  }
}
