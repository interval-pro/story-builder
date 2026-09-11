import { spawn } from 'node:child_process';
import { AppError, createLogger } from '@ai-engine/shared';
import type { ClaudeCliOptions, ClaudeResult, ClaudeStreamEvent, ClaudeToolUse } from './types';
import { readModelUsage, readSubagentStats } from './usage';

const logger = createLogger('claude-cli');

function buildArgs(options: ClaudeCliOptions, format: 'json' | 'stream-json'): string[] {
  const args = ['--print', '--output-format', format];
  if (format === 'stream-json') args.push('--verbose');
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.restricted) args.push('--restricted');
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.allowedTools?.length) args.push('--allowed-tools', ...options.allowedTools);
  if (options.disallowedTools?.length) args.push('--disallowed-tools', ...options.disallowedTools);
  for (const directory of options.additionalDirectories ?? []) args.push('--add-dir', directory);
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  else if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

/**
 * Both cache halves are recorded. `input_tokens` excludes the cached prefix, so
 * on a resumed session it is a few dozen tokens for a prompt that cost dollars;
 * reads and creation are where the rest of it is.
 */
export function readUsage(raw: Record<string, unknown>): ClaudeResult['usage'] {
  const usage = (raw['usage'] ?? {}) as Record<string, number>;
  return {
    inputTokens: usage['input_tokens'] ?? 0,
    outputTokens: usage['output_tokens'] ?? 0,
    cacheReadTokens: usage['cache_read_input_tokens'] ?? 0,
    cacheCreationTokens: usage['cache_creation_input_tokens'] ?? 0,
  };
}

function toResult(raw: Record<string, unknown>, toolUses: ClaudeToolUse[], transcript: string): ClaudeResult {
  return {
    text: typeof raw['result'] === 'string' ? raw['result'] : '',
    sessionId: String(raw['session_id'] ?? ''),
    isError: Boolean(raw['is_error']),
    numTurns: Number(raw['num_turns'] ?? 0),
    durationMs: Number(raw['duration_ms'] ?? 0),
    costUsd: Number(raw['total_cost_usd'] ?? 0),
    usage: readUsage(raw),
    modelUsage: readModelUsage(raw),
    subagentStats: readSubagentStats(raw),
    permissionDenials: Array.isArray(raw['permission_denials']) ? (raw['permission_denials'] as unknown[]) : [],
    terminalReason: (raw['terminal_reason'] as string | null) ?? null,
    toolUses,
    transcript,
    raw,
  };
}

/**
 * Runs the Claude Code CLI headless in the task workspace. The prompt goes in
 * on stdin so its size is not limited by the argument list.
 */
export function runClaudeCli(options: ClaudeCliOptions): Promise<ClaudeResult> {
  const format = options.onEvent ? 'stream-json' : 'json';
  const args = buildArgs(options, format);
  const binary = options.binary ?? 'claude';

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let buffer = '';
    let finalRaw: Record<string, unknown> | null = null;
    const toolUses: ClaudeToolUse[] = [];
    const transcript: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new AppError('claude_cli_timeout', `The Claude CLI did not finish within ${options.timeoutMs}ms`, 504));
    }, options.timeoutMs);

    const handleEvent = (event: ClaudeStreamEvent): void => {
      if (event.type === 'result') finalRaw = event as unknown as Record<string, unknown>;
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
          transcript.push(`[tool ${block.name}] ${JSON.stringify(block.input ?? {}).slice(0, 500)}`);
        }
        if (block.type === 'text' && block.text) transcript.push(block.text);
      }
      void options.onEvent?.(event);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (format !== 'stream-json') return;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          handleEvent(JSON.parse(trimmed) as ClaudeStreamEvent);
        } catch {
          logger.debug('unparseable stream line', { preview: trimmed.slice(0, 200) });
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      reject(
        new AppError(
          'claude_cli_unavailable',
          `Could not run "${binary}": ${error.message}. Install the Claude CLI and log in, or set AGENT_ENGINE=builtin.`,
          500,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;

      if (format === 'json') {
        try {
          finalRaw = JSON.parse(stdout.trim()) as Record<string, unknown>;
        } catch {
          finalRaw = null;
        }
      }

      if (!finalRaw) {
        reject(
          new AppError('claude_cli_failed', `The Claude CLI exited with ${code} and produced no result: ${stderr.slice(0, 2000)}`, 502),
        );
        return;
      }

      const result = toResult(finalRaw, toolUses, transcript.join('\n\n'));
      if (result.isError) {
        reject(new AppError('claude_cli_error', `The Claude CLI reported an error: ${result.text.slice(0, 2000)}`, 502));
        return;
      }
      resolve(result);
    });

    child.stdin.write(options.prompt);
    child.stdin.end();
  });
}

/** Reports whether the CLI is installed and authenticated. */
export async function claudeCliAvailable(binary = 'claude'): Promise<{ available: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ available: false, version: null }));
    child.on('close', (code) => resolve({ available: code === 0, version: code === 0 ? output.trim() : null }));
  });
}
