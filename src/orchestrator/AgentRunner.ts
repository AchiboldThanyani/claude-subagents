import { spawn } from 'child_process';
import { AgentConfig, POWER_TOOLS, RunResult } from '../types';

export interface RunOptions {
  onStream?: (chunk: string) => void;
  signal?: AbortSignal;
  sessionId?: string;
  resume?: string;
}

const HARD_TIMEOUT = 600_000; // 10 minutes

function buildAllowedTools(config: AgentConfig): string[] {
  const tools = config.powers.flatMap(p => POWER_TOOLS[p]);
  return tools.length > 0 ? ['--allowedTools', tools.join(',')] : [];
}

const IS_WIN = process.platform === 'win32';
const CLAUDE_BIN = IS_WIN ? 'claude.cmd' : 'claude';

// ── stream-json event shapes ──────────────────────────────────────────────
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
}

export async function runAgent(
  config: AgentConfig,
  input: string,
  opts: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(opts.resume
        ? ['--resume', opts.resume]
        : opts.sessionId ? ['--session-id', opts.sessionId] : []
      ),
      ...(!opts.resume ? ['--system-prompt', config.systemPrompt] : []),
      ...buildAllowedTools(config),
      ...(config.model ? ['--model', config.model] : []),
    ];

    // Pass prompt as the final positional argument (stdin piping is flaky on Windows)
    args.push(input);

    const start = Date.now();
    const child = spawn(CLAUDE_BIN, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: IS_WIN, // required on Windows to resolve .cmd shims
      windowsHide: true,
    });

    let finished = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let finalOutput = '';
    let streamedText = '';

    const finish = (result: RunResult) => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch { /* already dead */ }
      resolve(result);
    };

    const handleEvent = (evt: StreamEvent) => {
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) {
            // Only emit the *new* portion beyond what we've already streamed
            const newText = block.text;
            if (newText.length > streamedText.length && newText.startsWith(streamedText)) {
              const delta = newText.slice(streamedText.length);
              streamedText = newText;
              opts.onStream?.(delta);
            } else if (!streamedText.includes(newText)) {
              streamedText += (streamedText ? '\n' : '') + newText;
              opts.onStream?.(newText);
            }
          } else if (block.type === 'tool_use' && block.name) {
            const hint = `\n› ${block.name}\n`;
            opts.onStream?.(hint);
          }
        }
      } else if (evt.type === 'result') {
        if (typeof evt.result === 'string') finalOutput = evt.result;
        finish({
          success: !evt.is_error,
          output: finalOutput || streamedText,
          durationMs: evt.duration_ms ?? (Date.now() - start),
          error: evt.is_error ? 'Agent reported error' : undefined,
        });
      }
    };

    child.stdout.on('data', (data: Buffer) => {
      stdoutBuf += data.toString('utf8');
      // NDJSON: split on newlines, keep last partial
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleEvent(JSON.parse(trimmed) as StreamEvent);
        } catch {
          // Non-JSON line — ignore (shouldn't happen in stream-json mode)
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderrBuf += data.toString('utf8');
    });

    child.on('error', (err) => {
      finish({
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: `Failed to spawn claude: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (finished) return;
      if (finalOutput || streamedText) {
        finish({
          success: code === 0,
          output: finalOutput || streamedText,
          durationMs: Date.now() - start,
          error: code !== 0 ? (stderrBuf.trim() || `Exited with code ${code}`) : undefined,
        });
      } else {
        finish({
          success: false,
          output: '',
          durationMs: Date.now() - start,
          error: stderrBuf.trim() || 'Claude exited with no output — check it is installed and on PATH.',
        });
      }
    });

    opts.signal?.addEventListener('abort', () => {
      finish({
        success: false,
        output: streamedText,
        durationMs: Date.now() - start,
        error: 'Cancelled',
      });
    });

    setTimeout(() => {
      if (!finished) {
        finish({
          success: streamedText.length > 0,
          output: finalOutput || streamedText,
          durationMs: Date.now() - start,
          error: 'Agent hit the time limit — output may be incomplete.',
        });
      }
    }, HARD_TIMEOUT);
  });
}

export async function checkClaudeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(CLAUDE_BIN, ['--version'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: IS_WIN,
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
