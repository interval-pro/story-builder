import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@ai-engine/shared';

const execFileAsync = promisify(execFile);
const logger = createLogger('docker');

export interface ContainerSpec {
  name: string;
  image: string;
  workspacePath: string;
  readOnlyWorkspace: boolean;
  cpuLimit: string;
  memoryLimit: string;
  networkMode: string;
  environment: Record<string, string>;
}

export interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Thin wrapper around the Docker CLI. Only this service ever calls it. */
export class DockerClient {
  async available(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
      return true;
    } catch {
      return false;
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await execFileAsync('docker', ['image', 'inspect', image]);
      return true;
    } catch {
      return false;
    }
  }

  async containerState(name: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Status}}', name]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async create(spec: ContainerSpec): Promise<string> {
    const args = [
      'run',
      '-d',
      '--name',
      spec.name,
      '--cpus',
      spec.cpuLimit,
      '--memory',
      spec.memoryLimit,
      '--network',
      spec.networkMode,
      '--workdir',
      '/workspace',
      '-v',
      `${spec.workspacePath}:/workspace${spec.readOnlyWorkspace ? ':ro' : ''}`,
      '--label',
      'ai-engine=sandbox',
    ];
    for (const [key, value] of Object.entries(spec.environment)) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(spec.image, 'sleep', 'infinity');

    const { stdout } = await execFileAsync('docker', args);
    const id = stdout.trim();
    logger.info('sandbox container created', { name: spec.name, id: id.slice(0, 12) });
    return id;
  }

  exec(name: string, command: string, timeoutMs: number, env: Record<string, string> = {}): Promise<ExecOutcome> {
    const started = Date.now();
    return new Promise((resolve) => {
      const args = ['exec', '-w', '/workspace'];
      for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
      args.push(name, '/bin/sh', '-c', command);

      const child = spawn('docker', args);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

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

  async pause(name: string): Promise<void> {
    await execFileAsync('docker', ['pause', name]).catch(() => undefined);
  }

  async unpause(name: string): Promise<void> {
    await execFileAsync('docker', ['unpause', name]).catch(() => undefined);
  }

  async remove(name: string): Promise<void> {
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => undefined);
  }

  async listSandboxes(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', 'label=ai-engine=sandbox', '--format', '{{.Names}}']);
      return stdout.split('\n').filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }
}

/**
 * Fallback execution on the host, used when Docker sandboxing is disabled.
 * The workspace is still an isolated Git worktree.
 */
export function runLocal(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}): Promise<ExecOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env, CI: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

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
