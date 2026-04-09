import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { AgentConfig, POWER_TOOLS, RunResult } from '../types';

export interface RunOptions {
  onStream?: (chunk: string) => void;
  signal?: AbortSignal;
  sessionId?: string;
  resume?: string;
}

// ── Silence timeouts (ms) ──────────────────────────────────────────────────
const SILENCE_IDLE      = 45_000;  // 45s: Claude can think silently before responding
const SILENCE_TOOL_USE  = 60_000;  // 60s: extended when tool use is in progress
const HARD_TIMEOUT      = 300_000; // 5 minutes absolute max

// ── Patterns that indicate Claude is actively working (not done) ───────────
const TOOL_USE_PATTERNS = [
  /Reading\s+\d+\s+file/i,
  /Searching\s+for/i,
  /Running\s+bash/i,
  /Writing\s+to/i,
  /Editing/i,
  /Bash\s+command/i,
  /Listing\s+\d+/i,
  /●+/,                         // progress dots
  /\bls\b|\bfind\b|\bgrep\b/,   // common shell commands in output
];

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

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r/g, '');
}

const CHROME_PATTERNS = [
  /^Welcome back .+!$/,
  /Claude Code v\d/,
  /Tips for getting started/,
  /Run \/init/,
  /Voice mode is now/,
  /Recent activity/,
  /No recent activity/,
  /^\s*>\s*$/,
  /^[▐▛▜▝▞▟█▘▙╭╮╰╯│]+\s*$/,
  /^\│/,                           // any box-bordered line (banner content)
  /^─{3,}$|^={3,}$/,               // horizontal rules we inject or TUI draws
  /Pollinating…|Bloviating…|Ruminating…|Cogitating…|Contemplating…/,
  /Deliberating…|Meditating…|Pondering…|Perambulating…|Theorizing…/,
  /Flibbertigibbeting|Flibbertigibbet/i,
  /esc to interrupt/i,
  /Do you want to proceed/i,
  /Use skill ".*:.*"\?/,
  /bypass permissions/i,
  /shift\+tab to cycle/i,
  /ctrl\+[a-z] to /i,
  /^[◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/,
  /·\s*\/\w+/,
  /^\s*\d+\s+\w+\.ts\b/,
  /lukhwaren|Organization$/,
  /AppData.+Programs.+VSCode/i,
  /claude\.ai|anthropic\.com/i,
  /Sonnet\s+\d|Haiku\s+\d|Opus\s+\d/,   // model name status lines
  /Claude Pro|Claude Max/,
  /^>\s*---/,                             // echoed prompt + context marker
  /^#\s*Context\s*$/,                     // injected context headers
  /^##\s*(Workspace|File|Selection|Language)\s*$/,
];

// Decoration chars used in Claude Code's animated spinner / thinking display
const DECORATION_CHARS = /[✶✻✽✸✼✾●✢·✦✧✨✩✪✫✬✭✮✯✰✱✲✳✴✵✺✹▸▹►▻◂◃◄◅◆◇◈◉◊◌◍◎◐◑◒◓◔◕↓↑←→⏵⏶⏷⏸⏹⏺*]/g;

function cleanOutput(raw: string): string {
  let text = stripAnsi(raw);
  // Strip injected context blocks (---\n# Context\n...\n---)
  text = text.replace(/---\r?\n#\s*Context[\s\S]*?---\r?\n?/g, '');
  // Strip spinner/thinking noise words that slip past line filters
  text = text.replace(/\b(thinking|Flibbertigibbeting|Flibbertigibbet)\b/g, '');
  return text
    .split('\n')
    .filter(line => {
      const l = line.trim();
      if (!l) return false;
      return !CHROME_PATTERNS.some(p => p.test(l));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')   // collapse excessive blank lines
    .trim();
}

/**
 * Aggressive cleaner for live stream chunks.
 * Claude Code's TUI uses cursor-position ANSI to animate spinners in-place.
 * Stripping ANSI leaves all animation frames piled up as visible text.
 * This function collapses that noise so only real content gets displayed.
 */
function cleanStreamChunk(raw: string): string {
  let text = stripAnsi(raw);

  // ── Strip decoration/spinner unicode chars ─────────────────────────────
  text = text.replace(DECORATION_CHARS, '');

  // ── Strip "thinking" spam from extended thinking mode ─────────────────
  text = text.replace(/\bthinking\b/g, '');

  // ── Strip token counts and timing blurbs ──────────────────────────────
  text = text.replace(/\d+(?:\.\d+)?[km]?\s*tokens?\b[^\n]*/gi, '');
  text = text.replace(/thought for \d+s\b/gi, '');
  text = text.replace(/\d+m\s*\d+s\b/g, '');
  text = text.replace(/\(\s*\d+[ms]\s*\d*[ms]?[^)]*\)/g, '');   // (10s · ↓ …)

  // ── Strip ctrl+key hints and status bar fragments ─────────────────────
  text = text.replace(/\(ctrl\+\w[^)]*\)/gi, '');
  text = text.replace(/bypass permissions[^\n]*/gi, '');
  text = text.replace(/shift\+tab[^\n]*/gi, '');
  text = text.replace(/Claude Code has switched[^\n]*/gi, '');
  text = text.replace(/Run `claude install[^\n]*/gi, '');

  // ── Per-line filter ────────────────────────────────────────────────────
  const lines = text.split('\n').filter(line => {
    const t = line.trim();
    if (!t || t.length < 2) return false;
    if (CHROME_PATTERNS.some(p => p.test(t))) return false;

    // Drop lines that are mostly numbers/symbols — artifact of overwrite-strip
    const letters = (t.match(/[a-zA-Z]/g) ?? []).length;
    const total   = t.replace(/\s/g, '').length;
    if (total > 6 && letters / total < 0.25) return false;

    return true;
  });

  return lines.join('\n').trim();
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
    let bypassConfirmed = false;
    let toolUseActive = false;  // tracks whether Claude is mid-tool-call

    // ── Fix B: preserve partial output on finish, distinguish timeout vs done ──
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
        // On hard timeout, surface a warning but keep partial output
        error: timedOut && output.length === 0
          ? 'Agent timed out with no output. Claude may not have started.'
          : timedOut
          ? 'Agent hit the time limit — output may be incomplete.'
          : undefined,
      });
    };

    // ── Fix A: adaptive silence timeout ────────────────────────────────────
    const resetSilence = () => {
      if (!promptSent) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      // Use a longer timeout if Claude is in the middle of tool use
      const timeout = toolUseActive ? SILENCE_TOOL_USE : SILENCE_IDLE;
      silenceTimer = setTimeout(() => finish(false), timeout);
    };

    term.onData((data: string) => {
      rawOutput += data;
      const clean = stripAnsi(data);

      // ── Detect tool use → extend silence window ──────────────────────────
      if (TOOL_USE_PATTERNS.some(p => p.test(clean))) {
        toolUseActive = true;
      }
      // ── After tool use output arrives, reset toolUseActive ────────────────
      // If data arrived and it's not a tool pattern, Claude is back to text output
      if (toolUseActive && !TOOL_USE_PATTERNS.some(p => p.test(clean))) {
        toolUseActive = false;
      }

      const streamText = cleanStreamChunk(data);
      if (streamText.trim()) opts.onStream?.(streamText);
      resetSilence();

      const flat = stripAnsi(rawOutput).replace(/\s/g, '').toLowerCase();

      if (!trustConfirmed && (flat.includes('trustthisfolder') || flat.includes('quicksafetycheck'))) {
        trustConfirmed = true;
        setTimeout(() => term.write('\r'), 300);
      }
      if (!bypassConfirmed && flat.includes('bypasspermissions')) {
        bypassConfirmed = true;
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

    term.onExit(() => {
      if (!finished) finish(false);
    });

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

    // ── Fix B: hard timeout surfaces partial output as warning ────────────
    setTimeout(() => finish(true), HARD_TIMEOUT);

    // No output after 12s → Claude not found on PATH
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
