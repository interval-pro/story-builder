export interface ClaudeCliOptions {
  /** Absolute path the CLI runs in. This is the task worktree. */
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Fixed session id, so a later call can resume the same conversation. */
  sessionId?: string;
  resumeSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Directories outside cwd the tools may also reach, one `--add-dir` each. */
  additionalDirectories?: string[];
  /** Removes the built-in tools that run commands or code. */
  restricted?: boolean;
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';
  timeoutMs: number;
  binary?: string;
  onEvent?: (event: ClaudeStreamEvent) => void | Promise<void>;
}

/** One line of `--output-format stream-json`. */
export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  };
  [key: string]: unknown;
}

export interface ClaudeToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The final `type: "result"` object the CLI prints. */
export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
  numTurns: number;
  durationMs: number;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  /** Per-model token counts, shape unspecified by the CLI. Null when absent. */
  modelUsage: Record<string, unknown> | null;
  /** What the run spent on subagents. Null when the CLI reported nothing. */
  subagentStats: Record<string, unknown> | null;
  /** Actions the CLI refused. An empty list is part of the verification. */
  permissionDenials: unknown[];
  terminalReason: string | null;
  toolUses: ClaudeToolUse[];
  transcript: string;
  raw: Record<string, unknown>;
}
