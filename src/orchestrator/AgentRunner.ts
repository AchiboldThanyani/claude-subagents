import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { AgentConfig, POWER_TOOLS, RunResult } from '../types';

export interface RunOptions {
  onStream?: (chunk: string) => void;
  signal?: AbortSignal;
  sessionId?: string;
  resume?: string;
}

const SILENCE_IDLE     = 45_000;
const SILENCE_TOOL_USE = 60_000;
const HARD_TIMEOUT     = 600_000;

const TOOL_USE_PATTERNS = [
  /Reading\s+\d+\s+file/i,
  /Searching\s+for/i,
  /Running\s+bash/i,
  /Writing\s+to/i,
  /Editing/i,
  /Bash\s+command/i,
  /Listed?\s+\d+/i,
  /●+/,
  /\bls\b|\bfind\b|\bgrep\b/,
];

// ── Patterns safe to strip from FINAL output (conservative) ──────────────
const OUTPUT_STRIP_PATTERNS: RegExp[] = [
  /^Welcome back .+!$/,
  /^Claude Code v\d/,
  /Tips for getting started/,
  /^Run \/init/,
  /Voice mode is now/,
  /^Recent activity$/,
  /^No recent activity$/,
  /^\s*>\s*$/,
  /^[▐▛▜▝▞▟█▘▙╭╮╰╯│▌▗▖▘▝─═╔╗╚╝╠╣╦╩╬]+\s*[▐▛▜▝▞▟█▘▙╭╮╰╯│▌▗▖▘▝─═]*\s*$/,
  /^\│/,
  /^─{3,}$|^={3,}$/,
  /^[◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/,
  /^\s*\d+\s+\w+\.ts\b/,
  /AppData.+Programs.+VSCode/i,
  /^#\s*Context\s*$/,
  /^##\s*Workspace\s/,
  /^##\s*File\s*$/,
  /^##\s*Selection\s*$/,
  /^##\s*Language\s*$/,
  /^\[Pasted text #\d+/i,
  /^ctrl\+g to edit/i,
  /^esc to interrupt/i,
  /^shift\+tab to cycle/i,
  /^⏵+bypass/i,
  /^·\s*\/\w+/,
  /^>\s*---/,
];

// ── Patterns for STREAM chunks only (more aggressive) ────────────────────
const STREAM_STRIP_PATTERNS: RegExp[] = [
  ...OUTPUT_STRIP_PATTERNS,
  /Pollinating…|Bloviating…|Ruminating…|Cogitating…|Contemplating…/,
  /Deliberating…|Meditating…|Pondering…|Perambulating…|Theorizing…/,
  /Schlepping…|Crunching…|Baking…|Channeling…|Marinating…|Simmering…/,
  /Flibbertigibbeting|Flibbertigibbet/i,
  /(\b\w+…\s*){2,}/,
  /Sautéed for|Baked for|Crunched for|Simmered for|Marinated for/i,
  /^\(thought for \d+/i,
  /^Tip:\s+Use\s+\/\w+/i,
  /bypass permissions/i,
  /shift\+tab to cycle/i,
  /ctrl\+[a-z] to /i,
  /lukhwaren|Organization$/,
  /claude\.ai|anthropic\.com/i,
  /Sonnet\s*\d|Haiku\s*\d|Opus\s*\d/,
  /Claude\s*Pro|Claude\s*Max/,
  /Credit balance/i,
  /^□\s|^☐\s|^\[[ x]\]\s/,
  /^[0-9]+\s+tasks?\s*\(/i,
  /^\d+\s+done,\s*\d+\s+open/i,
];

const DECORATION_CHARS = /[✶✻✽✸✼✾●✢·✦✧✨✩✪✫✬✭✮✯✰✱✲✳✴✵✺✹▸▹►▻◂◃◄◅◆◇◈◉◊◌◍◎◐◑◒◓◔◕↓↑←→⏵⏶⏷⏸⏹⏺*]/g;

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r/g, '');
}

function cleanOutput(raw: string): string {
  let text = stripAnsi(raw);
  text = text.replace(/---\r?\n#\s*Context[\s\S]*?---\r?\n?/g, '');
  return text
    .split('\n')
    .filter(line => {
      const l = line.trim();
      if (!l) return false;
      return !OUTPUT_STRIP_PATTERNS.some((p: RegExp) => p.test(l));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanStreamChunk(raw: string): string {
  let text = stripAnsi(raw);
  // Strip injected context blocks before any other processing
  text = text.replace(/---\r?\n#\s*Context[\s\S]*?---\r?\n?/g, '');
  text = text.replace(DECORATION_CHARS, '');
  text = text.replace(/\bthinking\b/g, '');
  // Kill repeated spinner word fragments (e.g. "Channeling…Channeling…Channeling…")
  text = text.replace(/(\b\w+…\s*){2,}/g, '');
  // Kill "(thought for Ns)" hints
  text = text.replace(/\(thought for \d+s\)/gi, '');
  // Kill tip lines
  text = text.replace(/Tip:\s+Use\s+\/\w+[^\n]*/gi, '');
  text = text.replace(/\d+(?:\.\d+)?[km]?\s*tokens?\b[^\n]*/gi, '');
  text = text.replace(/thought for \d+s\b/gi, '');
  text = text.replace(/\d+m\s*\d+s\b/g, '');
  text = text.replace(/\(\s*\d+[ms]\s*\d*[ms]?[^)]*\)/g, '');
  text = text.replace(/\(ctrl\+\w[^)]*\)/gi, '');
  text = text.replace(/bypass permissions[^\n]*/gi, '');
  text = text.replace(/shift\+tab[^\n]*/gi, '');
  text = text.replace(/Claude Code has switched[^\n]*/gi, '');
  text = text.replace(/Run `claude install[^\n]*/gi, '');
  text = text.replace(/Baked for \d+s[^\n]*/gi, '');
  text = text.replace(/Crunched for [^\n]*/gi, '');
  text = text.replace(/Credit balance[^\n]*/gi, '');

  const lines = text.split('\n').filter(line => {
    const t = line.trim();
    if (!t || t.length < 2) return false;
    if (STREAM_STRIP_PATTERNS.some((p: RegExp) => p.test(t))) return false;
    const letters = (t.match(/[a-zA-Z]/g) ?? []).length;
    const total   = t.replace(/\s/g, '').length;
    if (total > 6 && letters / total < 0.25) return false;
    return true;
  });

  return lines.join('\n').trim();
}

function resolveSpawn(extraArgs: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'cmd.exe', args: ['/c', 'claude', ...extraArgs] };
  }
  return { file: 'claude', args: extraArgs };
}

function buildAllowedTools(config: AgentConfig): string[] {
  const tools = config.powers.flatMap(p => POWER_TOOLS[p]);
  return tools.length > 0 ? ['--allowedTools', tools.join(',')] : [];
}

export async function runAgent(
  config: AgentConfig,
  input: string,
  opts: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      ...(opts.resume
        ? ['--resume', opts.resume]
        : opts.sessionId ? ['--session-id', opts.sessionId] : []
      ),
      ...(!opts.resume ? ['--system-prompt', config.systemPrompt] : []),
      ...buildAllowedTools(config),
      ...(config.model ? ['--model', config.model] : []),
    ];

    const { file, args } = resolveSpawn(claudeArgs);
    const start = Date.now();

    const term = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as { [key: string]: string },
    });

    let rawOutput = '';
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let promptSent = false;
    let firstDataReceived = false;
    let finished = false;
    let trustConfirmed = false;
    let bypassConfirmed = 0;
    let toolUseActive = false;

    const finish = (timedOut = false) => {
      if (finished) return;
      finished = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      try { term.kill(); } catch { /* already dead */ }
      const output = cleanOutput(rawOutput);
      resolve({
        success: !timedOut || output.length > 0,
        output,
        durationMs: Date.now() - start,
        error: timedOut && output.length === 0
          ? 'Agent timed out with no output.'
          : timedOut
          ? 'Agent hit the time limit — output may be incomplete.'
          : undefined,
      });
    };

    const resetSilence = () => {
      if (!promptSent) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      const timeout = toolUseActive ? SILENCE_TOOL_USE : SILENCE_IDLE;
      silenceTimer = setTimeout(() => finish(false), timeout);
    };

    term.onData((data: string) => {
      rawOutput += data;
      const clean = stripAnsi(data);

      if (TOOL_USE_PATTERNS.some(p => p.test(clean))) toolUseActive = true;
      if (toolUseActive && !TOOL_USE_PATTERNS.some(p => p.test(clean))) toolUseActive = false;

      const streamText = cleanStreamChunk(data);
      if (streamText.trim()) opts.onStream?.(streamText);
      resetSilence();

      const flat = stripAnsi(rawOutput).replace(/\s/g, '').toLowerCase();

      if (!trustConfirmed && (flat.includes('trustthisfolder') || flat.includes('quicksafetycheck'))) {
        trustConfirmed = true;
        setTimeout(() => term.write('\r'), 300);
      }
      // Handle bypass permissions — may appear multiple times (once per tool call)
      const bypassCount = (flat.match(/bypasspermissions/g) || []).length;
      if (bypassCount > bypassConfirmed) {
        bypassConfirmed = bypassCount;
        setTimeout(() => {
          term.write('\x1B[B');
          setTimeout(() => term.write('\r'), 150);
        }, 400);
      }

      if (!firstDataReceived) {
        firstDataReceived = true;
        setTimeout(() => {
          if (finished) return;
          promptSent = true;
          term.write(input + '\r');
          resetSilence();
        }, 4000);
      }
    });

    term.onExit(() => { if (!finished) finish(false); });

    opts.signal?.addEventListener('abort', () => {
      finished = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      try { term.kill(); } catch { /* ignore */ }
      resolve({
        success: false,
        output: cleanOutput(rawOutput),
        durationMs: Date.now() - start,
        error: 'Cancelled',
      });
    });

    setTimeout(() => finish(true), HARD_TIMEOUT);

    setTimeout(() => {
      if (!firstDataReceived && !finished) {
        finished = true;
        try { term.kill(); } catch { /* ignore */ }
        resolve({
          success: false,
          output: '',
          durationMs: Date.now() - start,
          error: 'Claude did not start — check it is installed and on PATH.',
        });
      }
    }, 12_000);
  });
}

export async function checkClaudeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { file, args } = resolveSpawn(['--version']);
      const term = pty.spawn(file, args, {
        name: 'xterm',
        cols: 80,
        rows: 10,
        env: process.env as { [key: string]: string },
      });
      term.onExit(({ exitCode }) => resolve(exitCode === 0));
    } catch {
      resolve(false);
    }
  });
}
