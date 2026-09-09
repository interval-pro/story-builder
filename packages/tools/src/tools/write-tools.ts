import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertWorkspacePath } from '@ai-engine/security';
import type { ToolResult, ToolSpec } from '../types';
import { optionalBoolean, requireString } from '../types';

const WRITE_PHASES = ['IMPLEMENTATION', 'INTEGRATION'] as const;

interface WriteFileInput {
  path: string;
  content: string;
  createDirectories: boolean;
}

export const writeFileTool: ToolSpec<WriteFileInput> = {
  name: 'write_file',
  description: 'Create or overwrite a file inside the task workspace. Only available after the review has been approved.',
  capability: 'workspace.write',
  phases: [...WRITE_PHASES],
  timeoutMs: 20_000,
  maxOutputChars: 4000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace relative file path' },
      content: { type: 'string', description: 'Complete new file content' },
      createDirectories: { type: 'boolean' },
    },
    required: ['path', 'content'],
  },
  validate(input) {
    return {
      path: requireString(input, 'path'),
      content: typeof input['content'] === 'string' ? (input['content'] as string) : '',
      createDirectories: optionalBoolean(input, 'createDirectories', true),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const absolute = assertWorkspacePath(context.workspacePath, input.path);
    if (input.createDirectories) await mkdir(path.dirname(absolute), { recursive: true });
    let previousLines = 0;
    try {
      previousLines = (await readFile(absolute, 'utf8')).split('\n').length;
    } catch {
      previousLines = 0;
    }
    await writeFile(absolute, input.content, 'utf8');
    const lines = input.content.split('\n').length;
    return {
      output: `Wrote ${input.path} (${lines} lines, previously ${previousLines}).`,
      summary: `wrote ${input.path}`,
      metadata: { path: input.path, lines, previousLines },
    };
  },
};

interface ApplyPatchInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

export const applyPatchTool: ToolSpec<ApplyPatchInput> = {
  name: 'apply_patch',
  description: 'Replace an exact fragment of an existing file. Prefer this over write_file for edits to large files.',
  capability: 'workspace.write',
  phases: [...WRITE_PHASES],
  timeoutMs: 20_000,
  maxOutputChars: 4000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string', description: 'Exact text to replace, including indentation' },
      newText: { type: 'string', description: 'Replacement text' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  validate(input) {
    return {
      path: requireString(input, 'path'),
      oldText: requireString(input, 'oldText'),
      newText: typeof input['newText'] === 'string' ? (input['newText'] as string) : '',
      replaceAll: optionalBoolean(input, 'replaceAll', false),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const absolute = assertWorkspacePath(context.workspacePath, input.path);
    const content = await readFile(absolute, 'utf8');
    const occurrences = content.split(input.oldText).length - 1;
    if (occurrences === 0) {
      return { output: `The given text was not found in ${input.path}.`, summary: 'patch target not found', isError: true };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        output: `The given text occurs ${occurrences} times in ${input.path}. Provide more context or set replaceAll.`,
        summary: 'patch target not unique',
        isError: true,
      };
    }
    const updated = input.replaceAll
      ? content.split(input.oldText).join(input.newText)
      : content.replace(input.oldText, input.newText);
    await writeFile(absolute, updated, 'utf8');
    return {
      output: `Patched ${input.path} (${occurrences} occurrence(s) replaced).`,
      summary: `patched ${input.path}`,
      metadata: { path: input.path, occurrences },
    };
  },
};

export const deleteFileTool: ToolSpec<{ path: string }> = {
  name: 'delete_file',
  description: 'Delete a file inside the task workspace.',
  capability: 'workspace.write',
  phases: [...WRITE_PHASES],
  timeoutMs: 10_000,
  maxOutputChars: 2000,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  validate(input) {
    return { path: requireString(input, 'path') };
  },
  async execute(input, context): Promise<ToolResult> {
    const absolute = assertWorkspacePath(context.workspacePath, input.path);
    await rm(absolute, { force: true });
    return { output: `Deleted ${input.path}.`, summary: `deleted ${input.path}`, metadata: { path: input.path } };
  },
};
