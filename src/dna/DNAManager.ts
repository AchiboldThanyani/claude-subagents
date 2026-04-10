import * as fs from 'fs';
import * as path from 'path';
import { AgentType } from '../types';

export type DNATone       = 'formal' | 'casual' | 'direct' | 'terse';
export type DNAVerbosity  = 'concise' | 'balanced' | 'detailed';

export interface AgentDNA {
  tone?:      DNATone;
  verbosity?: DNAVerbosity;
  focus?:     string;   // e.g. "security implications first"
  persona?:   string;   // freeform extra instruction
}

export type DNAStore = Partial<Record<AgentType | string, AgentDNA>>;

const TONE_PROMPTS: Record<DNATone, string> = {
  formal:  'Use a formal, professional tone.',
  casual:  'Use a casual, conversational tone.',
  direct:  'Be direct and no-nonsense. Skip pleasantries.',
  terse:   'Be extremely terse. Fewer words is always better.',
};

const VERBOSITY_PROMPTS: Record<DNAVerbosity, string> = {
  concise:  'Keep responses short. Use bullet points. No lengthy explanations.',
  balanced: 'Balance brevity with clarity. Explain when it matters.',
  detailed: 'Be thorough. Explain your reasoning. Cover edge cases.',
};

export class DNAManager {
  private store: DNAStore = {};
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'dna.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.store = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as DNAStore;
    } catch { /* corrupt — start fresh */ }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  getStore(): DNAStore {
    return JSON.parse(JSON.stringify(this.store));
  }

  getDNA(agentType: AgentType | string): AgentDNA {
    return this.store[agentType] ?? {};
  }

  setDNA(agentType: AgentType | string, dna: AgentDNA): void {
    // Remove empty fields so we don't persist noise
    const cleaned: AgentDNA = {};
    if (dna.tone)      cleaned.tone      = dna.tone;
    if (dna.verbosity) cleaned.verbosity = dna.verbosity;
    if (dna.focus?.trim())   cleaned.focus   = dna.focus.trim();
    if (dna.persona?.trim()) cleaned.persona = dna.persona.trim();

    if (Object.keys(cleaned).length === 0) {
      delete this.store[agentType];
    } else {
      this.store[agentType] = cleaned;
    }
    this.save();
  }

  clearDNA(agentType: AgentType | string): void {
    delete this.store[agentType];
    this.save();
  }

  /** Build the persona block to prepend to agent prompts */
  buildDNABlock(agentType: AgentType | string): string {
    const dna = this.store[agentType];
    if (!dna || Object.keys(dna).length === 0) return '';

    const lines: string[] = ['## Agent Persona\n'];

    if (dna.tone)      lines.push(TONE_PROMPTS[dna.tone]);
    if (dna.verbosity) lines.push(VERBOSITY_PROMPTS[dna.verbosity]);
    if (dna.focus)     lines.push(`Focus especially on: ${dna.focus}`);
    if (dna.persona)   lines.push(dna.persona);

    return lines.join('\n') + '\n\n---\n\n';
  }
}
