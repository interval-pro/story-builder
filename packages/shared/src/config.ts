import path from 'node:path';
import { AppError } from './errors';

export interface DatabaseConfig {
  url: string;
  maxConnections: number;
}

export interface AiProviderConfig {
  provider: 'anthropic' | 'openai' | 'mock';
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

export interface PathsConfig {
  /** Absolute path of the installation: the engine, its prompts and its state. */
  installRoot: string;
  /** Absolute path of the repository this installation works on. */
  projectRoot: string;
  /** Root directory that holds one Git worktree per task. */
  workspacesRoot: string;
  /** Root directory of the artifact store volume. */
  artifactsRoot: string;
}

export interface ServiceConfig {
  env: 'development' | 'test' | 'production';
  apiPort: number;
  apiBaseUrl: string;
  sandboxManagerPort: number;
  sandboxManagerUrl: string;
  orchestratorTickMs: number;
  workerPollMs: number;
  workerConcurrency: number;
  maxQaIterations: number;
  jobMaxAttempts: number;
  jobLeaseSeconds: number;
}

export interface AgentEngineConfig {
  /** Which execution engine runs the agents. */
  engine: 'claude-code' | 'builtin';
  /** Path or name of the Claude Code executable. */
  claudeBinary: string;
  /** Optional model override passed to the Claude CLI. */
  claudeModel: string | undefined;
  claudeTimeoutMs: number;
  /** Budget for the pass that writes the answer. Defaults to claudeTimeoutMs. */
  claudeResultTimeoutMs: number;
}

export interface GitHubConfig {
  token: string | undefined;
  apiBaseUrl: string;
}

export interface SystemConfig {
  database: DatabaseConfig;
  ai: AiProviderConfig;
  paths: PathsConfig;
  service: ServiceConfig;
  agents: AgentEngineConfig;
  github: GitHubConfig;
  sandbox: {
    enabled: boolean;
    image: string;
    cpuLimit: string;
    memoryLimit: string;
    networkMode: string;
    commandTimeoutMs: number;
  };
}

function str(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new AppError('missing_configuration', `Environment variable ${name} is required`, 500, { name });
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('invalid_configuration', `Environment variable ${name} must be an integer`, 500, { name, raw });
  }
  return parsed;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new AppError('invalid_configuration', `Environment variable ${name} must be a number`, 500, { name, raw });
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

let cached: SystemConfig | undefined;

export function loadConfig(reload = false): SystemConfig {
  if (cached && !reload) return cached;
  const provider = str('AI_PROVIDER', 'mock') as AiProviderConfig['provider'];
  const apiPort = int('API_PORT', 4000);
  const sandboxManagerPort = int('SANDBOX_MANAGER_PORT', 4100);
  const installRoot = str('INSTALL_ROOT', process.cwd());
  cached = {
    database: {
      url: str('DATABASE_URL', 'postgres://ai_engine:ai_engine@localhost:5432/ai_engine'),
      maxConnections: int('DATABASE_MAX_CONNECTIONS', 10),
    },
    ai: {
      provider,
      model: str('AI_MODEL', provider === 'anthropic' ? 'claude-opus-5' : provider === 'openai' ? 'gpt-4.1' : 'mock-model'),
      apiKey: optional('AI_API_KEY') ?? optional('ANTHROPIC_API_KEY') ?? optional('OPENAI_API_KEY'),
      baseUrl: optional('AI_BASE_URL'),
      maxOutputTokens: int('AI_MAX_OUTPUT_TOKENS', 8000),
      temperature: float('AI_TEMPERATURE', 0.2),
      requestTimeoutMs: int('AI_REQUEST_TIMEOUT_MS', 300_000),
    },
    paths: {
      installRoot,
      projectRoot: str('PROJECT_ROOT', process.cwd()),
      // Worktrees and artifacts belong to the installation, so the repository
      // being worked on never accumulates state the system owns.
      workspacesRoot: str('WORKSPACES_ROOT', path.join(installRoot, '.ai-workspaces')),
      artifactsRoot: str('ARTIFACTS_ROOT', path.join(installRoot, '.artifacts')),
    },
    service: {
      env: (str('NODE_ENV', 'development') as ServiceConfig['env']),
      apiPort,
      apiBaseUrl: str('API_BASE_URL', `http://localhost:${apiPort}`),
      sandboxManagerPort,
      sandboxManagerUrl: str('SANDBOX_MANAGER_URL', `http://localhost:${sandboxManagerPort}`),
      orchestratorTickMs: int('ORCHESTRATOR_TICK_MS', 2000),
      workerPollMs: int('WORKER_POLL_MS', 1000),
      workerConcurrency: int('WORKER_CONCURRENCY', 2),
      maxQaIterations: int('MAX_QA_ITERATIONS', 5),
      jobMaxAttempts: int('JOB_MAX_ATTEMPTS', 3),
      jobLeaseSeconds: int('JOB_LEASE_SECONDS', 900),
    },
    agents: {
      engine: (str('AGENT_ENGINE', 'claude-code') as AgentEngineConfig['engine']),
      claudeBinary: str('CLAUDE_BINARY', 'claude'),
      claudeModel: optional('CLAUDE_MODEL'),
      claudeTimeoutMs: int('CLAUDE_TIMEOUT_MS', 3_600_000),
      claudeResultTimeoutMs: int('CLAUDE_RESULT_TIMEOUT_MS', int('CLAUDE_TIMEOUT_MS', 3_600_000)),
    },
    github: {
      token: optional('GITHUB_TOKEN'),
      apiBaseUrl: str('GITHUB_API_BASE_URL', 'https://api.github.com'),
    },
    sandbox: {
      enabled: bool('SANDBOX_DOCKER_ENABLED', true),
      image: str('SANDBOX_IMAGE', 'ai-engine/sandbox:latest'),
      cpuLimit: str('SANDBOX_CPU_LIMIT', '2'),
      memoryLimit: str('SANDBOX_MEMORY_LIMIT', '4g'),
      networkMode: str('SANDBOX_NETWORK_MODE', 'bridge'),
      commandTimeoutMs: int('SANDBOX_COMMAND_TIMEOUT_MS', 900_000),
    },
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
