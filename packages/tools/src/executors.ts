import { spawn } from 'node:child_process';
import { createLogger } from '@ai-engine/shared';

const logger = createLogger('command-executor');

export interface CommandRequest {
  command: string;
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Read-only executions refuse to run in a writable container. */
  readOnly?: boolean;
}

export interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandExecutor {
  readonly kind: string;
  run(request: CommandRequest): Promise<CommandOutcome>;
}

/**
 * Runs commands directly on the host inside the task worktree. Used when Docker
 * sandboxing is disabled, and by the sandbox manager itself.
 */
export class LocalCommandExecutor implements CommandExecutor {
  readonly kind = 'local';

  constructor(private readonly defaultCwd: string) {}

  run(request: CommandRequest): Promise<CommandOutcome> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', request.command], {
        cwd: request.cwd ?? this.defaultCwd,
        env: { ...process.env, ...request.env, CI: '1' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${error.message}`, timedOut, durationMs: Date.now() - started });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - started });
      });
    });
  }
}

/**
 * Delegates execution to the sandbox manager, the only service that talks to
 * the Docker daemon. Workers never hold Docker privileges.
 */
export class SandboxCommandExecutor implements CommandExecutor {
  readonly kind = 'sandbox';

  constructor(private readonly sandboxManagerUrl: string, private readonly taskId: string) {}

  async run(request: CommandRequest): Promise<CommandOutcome> {
    const started = Date.now();
    const response = await fetch(`${this.sandboxManagerUrl}/sandboxes/${this.taskId}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: request.command,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        env: request.env ?? {},
        readOnly: request.readOnly ?? false,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error('sandbox exec failed', { status: response.status, text });
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Sandbox execution failed: ${response.status} ${text}`,
        timedOut: false,
        durationMs: Date.now() - started,
      };
    }
    return (await response.json()) as CommandOutcome;
  }
}
