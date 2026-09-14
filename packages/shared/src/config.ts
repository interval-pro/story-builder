import { AppError } from './errors';
import { stateRootFor } from './paths';

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
  /** Absolute path of the installation: the code, and nothing machine-specific. */
  installRoot: string;
  /**
   * The one directory outside the checkout that holds state: how to reach the
   * database, which commit is running, the process ids, the pre-migration dumps
   * and scratch copies of artifacts. See `statePaths`.
   */
  stateRoot: string;
}

export interface ServiceConfig {
  env: 'development' | 'test' | 'production';
  apiPort: number;
  apiBaseUrl: string;
  orchestratorTickMs: number;
  workerPollMs: number;
  workerConcurrency: number;
  jobLeaseSeconds: number;
  /** How long one build, test or setup command may run before it is stopped. */
  commandTimeoutMs: number;
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
  /**
   * Lets an agent delegate to a subagent. Off, and it should stay off: each
   * subagent opens its own context window, and none of the five agents has a
   * reason to delegate. If it is ever turned on, one subagent at a time is the
   * limit. Several at once is exactly the shape that multiplies spend, and
   * nothing in this lifecycle needs fan-out. The CLI has no flag for that limit,
   * so it is a contract on whoever turns this on, not something we enforce.
   */
  allowSubagents: boolean;
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
  const installRoot = str('INSTALL_ROOT', process.cwd());
  const stateRoot = str('STATE_ROOT', stateRootFor(installRoot));
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
      stateRoot,
    },
    service: {
      env: (str('NODE_ENV', 'development') as ServiceConfig['env']),
      apiPort,
      apiBaseUrl: str('API_BASE_URL', `http://localhost:${apiPort}`),
      orchestratorTickMs: int('ORCHESTRATOR_TICK_MS', 2000),
      workerPollMs: int('WORKER_POLL_MS', 1000),
      workerConcurrency: int('WORKER_CONCURRENCY', 2),
      // Clamped, because a lease shorter than the heartbeat can renew is how two
      // agents end up in one project directory. The worker renews every
      // max(30s, lease/3), so anything under 90s is reclaimed while it is still
      // running and a second worker starts the same job from the top. The agent
      // notices — it reports a concurrent writer and refuses — but by then two
      // sessions have been paid for.
      jobLeaseSeconds: Math.max(120, int('JOB_LEASE_SECONDS', 900)),
      commandTimeoutMs: int('COMMAND_TIMEOUT_MS', 900_000),
    },
    agents: {
      engine: (str('AGENT_ENGINE', 'claude-code') as AgentEngineConfig['engine']),
      claudeBinary: str('CLAUDE_BINARY', 'claude'),
      claudeModel: optional('CLAUDE_MODEL'),
      claudeTimeoutMs: int('CLAUDE_TIMEOUT_MS', 3_600_000),
      claudeResultTimeoutMs: int('CLAUDE_RESULT_TIMEOUT_MS', int('CLAUDE_TIMEOUT_MS', 3_600_000)),
      allowSubagents: bool('AGENT_ALLOW_SUBAGENTS', false),
    },
    github: {
      token: optional('GITHUB_TOKEN'),
      apiBaseUrl: str('GITHUB_API_BASE_URL', 'https://api.github.com'),
    },
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
