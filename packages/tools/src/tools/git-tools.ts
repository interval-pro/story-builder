import { changedFiles, fullDiff, GitClient, summarizeChanges } from '@ai-engine/git';
import type { ToolResult, ToolSpec } from '../types';
import { optionalNumber, optionalString, optionalStringArray } from '../types';

const READ_PHASES = ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const;

type GitOperation = 'status' | 'log' | 'branch' | 'file_history' | 'blame_summary';

interface InspectGitInput {
  operation: GitOperation;
  path?: string;
  limit: number;
}

export const inspectGitTool: ToolSpec<InspectGitInput> = {
  name: 'inspect_git',
  description: 'Inspect the Git state of the task workspace: status, recent commits, current branch or the history of one file.',
  capability: 'git.inspect',
  phases: [...READ_PHASES],
  timeoutMs: 30_000,
  maxOutputChars: 20_000,
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['status', 'log', 'branch', 'file_history', 'blame_summary'] },
      path: { type: 'string', description: 'File path, required for file_history and blame_summary' },
      limit: { type: 'integer', description: 'Number of commits to return' },
    },
    required: ['operation'],
  },
  validate(input) {
    const operation = optionalString(input, 'operation') ?? 'status';
    if (!['status', 'log', 'branch', 'file_history', 'blame_summary'].includes(operation)) {
      throw new Error(`Unsupported git operation: ${operation}`);
    }
    return {
      operation: operation as GitOperation,
      path: optionalString(input, 'path'),
      limit: optionalNumber(input, 'limit', 20),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const git = new GitClient(context.workspacePath);
    switch (input.operation) {
      case 'status': {
        const status = await git.status();
        const output = status.clean
          ? 'Working tree is clean.'
          : status.entries.map((entry) => `${entry.status.padEnd(3)} ${entry.path}`).join('\n');
        return { output, summary: `git status: ${status.entries.length} entries` };
      }
      case 'branch': {
        const branch = await git.currentBranch();
        const head = await git.headCommit();
        return { output: `branch: ${branch}\nhead: ${head}\nbase: ${context.baseCommit}`, summary: `on branch ${branch}` };
      }
      case 'log': {
        const commits = await git.log('HEAD', input.limit);
        const output = commits.map((commit) => `${commit.sha.slice(0, 10)} ${commit.date} ${commit.author}: ${commit.subject}`).join('\n');
        return { output: output || '(no commits)', summary: `git log: ${commits.length} commits` };
      }
      case 'file_history': {
        if (!input.path) throw new Error('file_history requires a path');
        const result = await git.run(['log', `-${input.limit}`, '--oneline', '--', input.path], { allowFailure: true });
        return { output: result.stdout || '(no history)', summary: `history of ${input.path}` };
      }
      case 'blame_summary': {
        if (!input.path) throw new Error('blame_summary requires a path');
        const result = await git.run(['shortlog', '-sne', 'HEAD', '--', input.path], { allowFailure: true });
        return { output: result.stdout || '(no authors)', summary: `blame summary for ${input.path}` };
      }
    }
  },
};

interface InspectDiffInput {
  baseRef?: string;
  files: string[];
  statOnly: boolean;
}

export const inspectDiffTool: ToolSpec<InspectDiffInput> = {
  name: 'inspect_diff',
  description: 'Show what this task changed relative to its base commit, either as a summary or as a full diff.',
  capability: 'git.inspect',
  phases: [...READ_PHASES],
  timeoutMs: 60_000,
  maxOutputChars: 120_000,
  inputSchema: {
    type: 'object',
    properties: {
      baseRef: { type: 'string', description: 'Base reference, defaults to the task base commit' },
      files: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these files' },
      statOnly: { type: 'boolean', description: 'Return only the per-file change summary' },
    },
  },
  validate(input) {
    return {
      baseRef: optionalString(input, 'baseRef'),
      files: optionalStringArray(input, 'files'),
      statOnly: Boolean(input['statOnly']),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const git = new GitClient(context.workspacePath);
    const baseRef = input.baseRef ?? context.baseCommit;
    const changes = await changedFiles(git, baseRef);
    const stat = changes
      .map((change) => `${change.changeType.padEnd(9)} +${change.insertions} -${change.deletions}  ${change.filePath}`)
      .join('\n');

    if (input.statOnly) {
      return {
        output: `${summarizeChanges(changes)}\n\n${stat || '(no changes)'}`,
        summary: summarizeChanges(changes),
        metadata: { fileCount: changes.length },
      };
    }

    const diff =
      input.files.length > 0
        ? (await git.run(['diff', baseRef, 'HEAD', '--', ...input.files], { allowFailure: true })).stdout
        : await fullDiff(git, baseRef);

    const artifact = await context.artifacts.put({
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      kind: 'diff',
      contentType: 'text/x-diff',
      content: diff,
      metadata: { baseRef, files: input.files },
    });

    return {
      output: `${summarizeChanges(changes)}\n\n${stat}\n\n${diff}`,
      summary: `diff against ${baseRef.slice(0, 10)}: ${summarizeChanges(changes)}`,
      artifactId: artifact.id,
      metadata: { fileCount: changes.length },
    };
  },
};
