import { assertCommandAllowed } from '@ai-engine/security';
import type { ToolResult, ToolSpec } from '../types';
import { optionalNumber, requireString } from '../types';

const DESTRUCTIVE = /\b(drop|truncate|delete\s+from|alter\s+table|update\s+\w+\s+set)\b/i;

interface InspectDatabaseInput {
  query: string;
  timeoutMs: number;
}

/**
 * Read-only database inspection. Only the development database of the task
 * sandbox is reachable; production credentials are never mounted.
 */
export const inspectDatabaseTool: ToolSpec<InspectDatabaseInput> = {
  name: 'inspect_database',
  description: 'Run a read-only SQL query against the development database of the task sandbox.',
  capability: 'database.inspect',
  phases: ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'INTEGRATION'],
  timeoutMs: 60_000,
  maxOutputChars: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A SELECT or SHOW statement' },
      timeoutMs: { type: 'integer' },
    },
    required: ['query'],
  },
  validate(input) {
    const query = requireString(input, 'query');
    if (DESTRUCTIVE.test(query)) {
      throw new Error('inspect_database only accepts read-only statements');
    }
    if (!/^\s*(select|show|explain|with|\\d)/i.test(query)) {
      throw new Error('inspect_database expects a SELECT, WITH, SHOW or EXPLAIN statement');
    }
    return { query, timeoutMs: optionalNumber(input, 'timeoutMs', 30_000) };
  },
  async execute(input, context): Promise<ToolResult> {
    const command = `psql "$DEV_DATABASE_URL" -c ${JSON.stringify(input.query)}`;
    const outcome = await context.executor.run({
      command,
      cwd: context.workspacePath,
      timeoutMs: input.timeoutMs,
      readOnly: true,
    });
    return {
      output: `${outcome.stdout}\n${outcome.stderr}`.trim() || '(no output)',
      summary: `database query exited ${outcome.exitCode}`,
      isError: outcome.exitCode !== 0,
      metadata: { exitCode: outcome.exitCode },
    };
  },
};

interface ExecuteDatabaseInput {
  command: string;
  timeoutMs: number;
}

/** Migrations and other development database writes, implementation phase only. */
export const executeDatabaseDevTool: ToolSpec<ExecuteDatabaseInput> = {
  name: 'execute_database_dev',
  description: 'Run a migration or other write operation against the development database of the task sandbox.',
  capability: 'database.execute_dev',
  phases: ['IMPLEMENTATION', 'INTEGRATION'],
  timeoutMs: 600_000,
  maxOutputChars: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Migration command, for example "npm run migrate"' },
      timeoutMs: { type: 'integer' },
    },
    required: ['command'],
  },
  validate(input) {
    const command = requireString(input, 'command');
    assertCommandAllowed(command, 'full');
    return { command, timeoutMs: optionalNumber(input, 'timeoutMs', 300_000) };
  },
  async execute(input, context): Promise<ToolResult> {
    const outcome = await context.executor.run({
      command: input.command,
      cwd: context.workspacePath,
      timeoutMs: input.timeoutMs,
    });
    const body = `$ ${input.command}\nexit code: ${outcome.exitCode}\n\n${outcome.stdout}\n${outcome.stderr}`.trim();
    const artifact = await context.artifacts.put({
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      kind: 'migration_log',
      content: body,
      metadata: { command: input.command, exitCode: outcome.exitCode },
    });
    return {
      output: body,
      summary: `database command exited ${outcome.exitCode}`,
      isError: outcome.exitCode !== 0,
      artifactId: artifact.id,
      metadata: { exitCode: outcome.exitCode },
    };
  },
};
