import * as fs from 'fs';
import * as path from 'path';
import { HistoryEntry } from '../types';

const MAX_ENTRIES = 500;

export class HistoryManager {
  private entries: HistoryEntry[] = [];
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'agent-history.json');
    this.load();
  }

  add(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const full: HistoryEntry = {
      ...entry,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    };
    this.entries.unshift(full);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
    this.save();
    return full;
  }

  getAll(): HistoryEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as HistoryEntry[];
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    } catch {
      // Non-fatal — history just won't persist
    }
  }
}
