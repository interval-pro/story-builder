import { assertCommandAllowed } from '@ai-engine/security';
import type { ToolContext, ToolResult, ToolSpec } from '../types';
import { optionalNumber, optionalString, requireString } from '../types';

const ALL_PHASES = ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const;

async function runAndFormat(
  context: ToolContext,
  command: string,
  timeoutMs: number,
  kind: string,
): Promise<ToolResult> {
  const outcome = await context.executor.run({
    command,
    cwd: context.workspacePath,
    timeoutMs,
    readOnly: !context.capabilities.includes('workspace.write'),
  });
  const body = [
    `$ ${command}`,
    `exit code: ${outcome.exitCode}${outcome.timedOut ? ' (timed out)' : ''}`,
    `duration: ${outcome.durationMs}ms`,
    '',
    outcome.stdout.trim(),
    outcome.stderr.trim() ? `\n--- stderr ---\n${outcome.stderr.trim()}` : '',
  ].join('\n');

  const artifact = await context.artifacts.put({
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    kind,
    content: body,
    metadata: { command, exitCode: outcome.exitCode, timedOut: outcome.timedOut },
  });

  return {
    output: body,
    summary: `${kind} "${command.slice(0, 80)}" exited ${outcome.exitCode}`,
    isError: outcome.exitCode !== 0,
    artifactId: artifact.id,
    metadata: { exitCode: outcome.exitCode, durationMs: outcome.durationMs, timedOut: outcome.timedOut, command },
  };
}

interface RunCommandInput {
  command: string;
  timeoutMs: number;
}

/** Read-only inspection commands, available to the research and QA agents. */
export const runSafeCommandTool: ToolSpec<RunCommandInput> = {
  name: 'run_safe_command',
  description: 'Run a read-only inspection command in the task workspace. Writes, network changes and Git mutations are refused.',
  capability: 'command.safe',
  phases: [...ALL_PHASES],
  timeoutMs: 180_000,
  maxOutputChars: 40_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
      timeoutMs: { type: 'integer' },
    },
    required: ['command'],
  },
  validate(input) {
    const command = requireString(input, 'command');
    assertCommandAllowed(command, 'safe');
    return { command, timeoutMs: optionalNumber(input, 'timeoutMs', 120_000) };
  },
  async execute(input, context) {
    return runAndFormat(context, input.command, input.timeoutMs, 'command_log');
  },
};

/** Full command execution, only granted during implementation and integration. */
export const runCommandTool: ToolSpec<RunCommandInput> = {
  name: 'run_command',
  description: 'Run a command in the task sandbox. Available only after the review has been approved.',
  capability: 'command.run',
  phases: ['IMPLEMENTATION', 'INTEGRATION'],
  timeoutMs: 900_000,
  maxOutputChars: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
    required: ['command'],
  },
  validate(input) {
    const command = requireString(input, 'command');
    assertCommandAllowed(command, 'full');
    return { command, timeoutMs: optionalNumber(input, 'timeoutMs', 600_000) };
  },
  async execute(input, context) {
    return runAndFormat(context, input.command, input.timeoutMs, 'command_log');
  },
};

interface RunTestsInput {
  command?: string;
  timeoutMs: number;
}

export const runTestsTool: ToolSpec<RunTestsInput> = {
  name: 'run_tests',
  description: 'Run the project test suite from the runtime manifest, or a specific test command.',
  capability: 'tests.run',
  phases: [...ALL_PHASES],
  timeoutMs: 1_800_000,
  maxOutputChars: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Test command, defaults to the runtime manifest test command' },
      timeoutMs: { type: 'integer' },
    },
  },
  validate(input) {
    const command = optionalString(input, 'command');
    if (command) assertCommandAllowed(command, 'full');
    return { command, timeoutMs: optionalNumber(input, 'timeoutMs', 1_200_000) };
  },
  async execute(input, context) {
    const command = input.command ?? 'npm test';
    return runAndFormat(context, command, input.timeoutMs, 'test_log');
  },
};

export const runBuildTool: ToolSpec<RunTestsInput> = {
  name: 'run_build',
  description: 'Run the project build command from the runtime manifest.',
  capability: 'build.run',
  phases: ['IMPLEMENTATION', 'INTEGRATION'],
  timeoutMs: 1_800_000,
  maxOutputChars: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
  },
  validate(input) {
    const command = optionalString(input, 'command');
    if (command) assertCommandAllowed(command, 'full');
    return { command, timeoutMs: optionalNumber(input, 'timeoutMs', 1_200_000) };
  },
  async execute(input, context) {
    const command = input.command ?? 'npm run build';
    return runAndFormat(context, command, input.timeoutMs, 'build_log');
  },
};

interface InstallDependencyInput {
  command: string;
  timeoutMs: number;
}

export const installDependencyTool: ToolSpec<InstallDependencyInput> = {
  name: 'install_dependencies',
  description: 'Install or update project dependencies inside the task sandbox.',
  capability: 'dependencies.modify',
  phases: ['IMPLEMENTATION'],
  timeoutMs: 1_800_000,
  maxOutputChars: 30_000,
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } },
    required: ['command'],
  },
  validate(input) {
    const command = requireString(input, 'command');
    assertCommandAllowed(command, 'full');
    if (!/^(npm|pnpm|yarn|pip|pip3|poetry|go|cargo|dotnet|mvn|gradle)\b/.test(command.trim())) {
      throw new Error('install_dependencies only accepts package manager commands');
    }
    return { command, timeoutMs: optionalNumber(input, 'timeoutMs', 900_000) };
  },
  async execute(input, context) {
    return runAndFormat(context, input.command, input.timeoutMs, 'dependency_log');
  },
};
