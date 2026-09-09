import type { Capability, ExecutionPhase } from '@ai-engine/domain';
import type { ArtifactStore } from '@ai-engine/artifacts';
import type { Logger } from '@ai-engine/shared';
import type { CommandExecutor } from './executors';

export interface ToolContext {
  projectId: string;
  taskId: string;
  runId: string;
  /** Absolute path of the task workspace (a Git worktree). */
  workspacePath: string;
  phase: ExecutionPhase;
  capabilities: readonly Capability[];
  executor: CommandExecutor;
  artifacts: ArtifactStore;
  logger: Logger;
  /** Secret values that must be scrubbed from every tool result. */
  secretValues: string[];
  /** Commit the task started from, used by diff and git tools. */
  baseCommit: string;
  /** Set by the tool layer while a tool is running, for audit records. */
  allowWeb: boolean;
}

export interface ToolResult {
  /** Text handed back to the model. Already truncated and redacted. */
  output: string;
  /** Short line recorded in the audit log. */
  summary: string;
  isError?: boolean;
  /** Set when the full output was written to the artifact store. */
  artifactId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolSpec<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: Capability;
  /** Phases in which this tool may be called at all. */
  phases: ExecutionPhase[];
  timeoutMs: number;
  maxOutputChars: number;
  validate(input: Record<string, unknown>): TInput;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Parameter "${key}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Parameter "${key}" must be a string`);
  return value;
}

export function optionalNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) throw new Error(`Parameter "${key}" must be a number`);
  return parsed;
}

export function optionalBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

export function optionalStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Parameter "${key}" must be an array of strings`);
  return value.map((entry) => String(entry));
}
