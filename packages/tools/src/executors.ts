import { spawn } from 'node:child_process';

export interface CommandRequest {
  command: string;
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
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
 * Runs commands on the host, in the project directory, on the story's branch.
 *
 * What a phase may run is decided before a command gets here, by the phase's
 * capabilities and the command policy. Nothing below this line restricts a
 * command further, and nothing pretends to.
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
