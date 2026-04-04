import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { AgentConfig, POWER_TOOLS, RunResult } from '../types';

export interface RunOptions {
  onStream?: (chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * On Windows, spawn via cmd.exe so VS Code's extension host
 * inherits the full user PATH (where claude.cmd lives).
 */
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

function cleanOutput(raw: string): string {
  return stripAnsi(raw)
    .split('\n')
    .filter(line => {
      const l = line.trim();
      if (!l) return false;
      // Only remove lines that are PURELY decorative (no real text content)
      if (l.match(/^[▐▛▜▝▞▟█▘▙╭╰│─┼·✻\s]+$/)) return false;
      if (l.includes('Welcome back') && l.includes('!')) return false;
      if (l.match(/Claude Code v\d/)) return false;
      if (l.includes('Tips for getting started')) return false;
      if (l.includes('Run /init')) return false;
      if (l.includes('Voice mode is now')) return false;
      if (l.includes('Recent activity')) return false;
      if (l.includes('No recent activity')) return false;
      if (l.match(/^\s*>\s*$/)) return false;
      if (l.match(/^\?\s/)) return false;
      if (l.includes('Accessing workspace')) return false;
      const flat = l.replace(/\s/g, '').toLowerCase();
      if (flat.includes('quicksafetycheck')) return false;
      if (flat.includes('trustthisfolder')) return false;
      if (flat.includes('securityguide')) return false;
      if (flat.includes('entertoconfirm')) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Run an agent via a real PTY so Claude uses the Pro subscription.
 *
 * Strategy:
 *   1. Spawn claude in a PTY (so it thinks it's interactive)
 *   2. On first output → wait 1.5s for the banner to finish → send prompt
 *   3. After prompt sent → 3s silence → finish
 */
export async function runAgent(
  config: AgentConfig,
  input: string,
  opts: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const claudeArgs = [
      '--system-prompt', config.systemPrompt,
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

    const finish = () => {
      if (finished) return;
      finished = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      try { term.kill(); } catch { /* already dead */ }
      resolve({
        success: true,
        output: cleanOutput(rawOutput),
        durationMs: Date.now() - start,
      });
    };

    const resetSilence = () => {
      if (!promptSent) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, 10000);
    };

    const NOISE = ['Welcome back', 'Accessing workspace', 'Quick safety check',
      'trust this folder', 'Claude Code\'ll be able', 'Security guide',
      'Yes, I trust', 'No, exit', 'Enter to confirm', 'Voice mode'];

    term.onData((data: string) => {
      rawOutput += data;
      const clean = stripAnsi(data);
      const isNoise = NOISE.some(n => clean.includes(n) || clean.replace(/\s/g,'').toLowerCase().includes(n.replace(/\s/g,'').toLowerCase()));
      if (clean.trim() && !isNoise) opts.onStream?.(clean);
      resetSilence();

      // Auto-confirm the workspace trust prompt (only once, with delay)
      // Spaces may be ANSI cursor movements, so compare without whitespace
      if (!trustConfirmed) {
        const flat = stripAnsi(rawOutput).replace(/\s/g, '').toLowerCase();
        if (flat.includes('trustthisfolder') || flat.includes('quicksafetycheck')) {
          trustConfirmed = true;
          // Option 1 (trust) is pre-selected — just press Enter to confirm
          setTimeout(() => term.write('\r'), 300);
        }
      }

      // On first data: wait 1.5s for banner to finish, then send prompt
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
      if (!finished) {
        finished = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        resolve({
          success: true,
          output: cleanOutput(rawOutput),
          durationMs: Date.now() - start,
        });
      }
    });

    opts.signal?.addEventListener('abort', () => {
      finished = true;
      try { term.kill(); } catch { /* ignore */ }
      resolve({ success: false, output: '', durationMs: Date.now() - start, error: 'Cancelled' });
    });

    // Hard timeout: 2 minutes
    setTimeout(() => finish(), 120_000);

    // No output at all after 12s → claude not found
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
