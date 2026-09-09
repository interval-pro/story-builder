import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { countLines } from '@ai-engine/shared';
import { assertWorkspacePath, isIgnoredPath, IGNORED_DIRECTORIES } from '@ai-engine/security';
import type { ToolContext, ToolResult, ToolSpec } from '../types';
import { optionalBoolean, optionalNumber, optionalString, requireString } from '../types';

const READ_PHASES = ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const;

/** A NUL byte is the cheapest reliable signal that a file is not source code. */
const NUL = String.fromCharCode(0);

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export const readFileTool: ToolSpec<ReadFileInput> = {
  name: 'read_file',
  description: 'Read a UTF-8 file from the task workspace. Optionally limit the result to a line range.',
  capability: 'repo.read',
  phases: [...READ_PHASES],
  timeoutMs: 15_000,
  maxOutputChars: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace relative file path' },
      startLine: { type: 'integer', description: 'First line to return, 1 based' },
      endLine: { type: 'integer', description: 'Last line to return, inclusive' },
    },
    required: ['path'],
  },
  validate(input) {
    return {
      path: requireString(input, 'path'),
      startLine: input['startLine'] === undefined ? undefined : optionalNumber(input, 'startLine', 1),
      endLine: input['endLine'] === undefined ? undefined : optionalNumber(input, 'endLine', 0),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const absolute = assertWorkspacePath(context.workspacePath, input.path);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      return { output: `${input.path} is a directory. Use list_directory instead.`, summary: 'path is a directory', isError: true };
    }
    if (info.size > 5 * 1024 * 1024) {
      return { output: `${input.path} is ${info.size} bytes, which is too large to read.`, summary: 'file too large', isError: true };
    }
    const content = await readFile(absolute, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, input.startLine ?? 1);
    const end = Math.min(lines.length, input.endLine && input.endLine > 0 ? input.endLine : lines.length);
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, index) => `${String(start + index).padStart(5, ' ')}  ${line}`).join('\n');
    return {
      output: `${input.path} (lines ${start}-${end} of ${lines.length})\n\n${numbered}`,
      summary: `read ${input.path} (${slice.length} lines)`,
      metadata: { totalLines: lines.length },
    };
  },
};

interface ListDirectoryInput {
  path: string;
  recursive: boolean;
  maxEntries: number;
}

export const listDirectoryTool: ToolSpec<ListDirectoryInput> = {
  name: 'list_directory',
  description: 'List files and directories in the task workspace. Build output and dependency directories are skipped.',
  capability: 'repo.read',
  phases: [...READ_PHASES],
  timeoutMs: 20_000,
  maxOutputChars: 40_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace relative directory, defaults to the workspace root' },
      recursive: { type: 'boolean', description: 'Walk subdirectories' },
      maxEntries: { type: 'integer', description: 'Maximum number of entries to return' },
    },
  },
  validate(input) {
    return {
      path: optionalString(input, 'path') ?? '.',
      recursive: optionalBoolean(input, 'recursive', false),
      maxEntries: optionalNumber(input, 'maxEntries', 400),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const root = assertWorkspacePath(context.workspacePath, input.path);
    const entries: string[] = [];

    async function walk(directory: string, depth: number): Promise<void> {
      if (entries.length >= input.maxEntries) return;
      const items = await readdir(directory, { withFileTypes: true });
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= input.maxEntries) return;
        if (IGNORED_DIRECTORIES.has(item.name)) continue;
        const absolute = path.join(directory, item.name);
        const relative = path.relative(context.workspacePath, absolute).split(path.sep).join('/');
        if (item.isDirectory()) {
          entries.push(`${relative}/`);
          if (input.recursive && depth < 8) await walk(absolute, depth + 1);
        } else {
          entries.push(relative);
        }
      }
    }

    await walk(root, 0);
    return {
      output: entries.length > 0 ? entries.join('\n') : '(empty directory)',
      summary: `listed ${entries.length} entries in ${input.path}`,
      metadata: { count: entries.length },
    };
  },
};

interface SearchTextInput {
  query: string;
  path: string;
  glob?: string;
  maxResults: number;
  caseSensitive: boolean;
}

export const searchTextTool: ToolSpec<SearchTextInput> = {
  name: 'search_text',
  description: 'Search the workspace for a regular expression and return matching lines with their file and line number.',
  capability: 'repo.search',
  phases: [...READ_PHASES],
  timeoutMs: 60_000,
  maxOutputChars: 40_000,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Workspace relative directory to search in' },
      glob: { type: 'string', description: 'Optional file suffix filter, for example *.ts' },
      maxResults: { type: 'integer' },
      caseSensitive: { type: 'boolean' },
    },
    required: ['query'],
  },
  validate(input) {
    return {
      query: requireString(input, 'query'),
      path: optionalString(input, 'path') ?? '.',
      glob: optionalString(input, 'glob'),
      maxResults: optionalNumber(input, 'maxResults', 80),
      caseSensitive: optionalBoolean(input, 'caseSensitive', false),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const searchRoot = assertWorkspacePath(context.workspacePath, input.path);
    const pattern = new RegExp(input.query, input.caseSensitive ? '' : 'i');
    const results: string[] = [];
    const suffix = input.glob ? input.glob.replace(/^\*/, '') : null;

    async function walk(directory: string): Promise<void> {
      if (results.length >= input.maxResults) return;
      const items = await readdir(directory, { withFileTypes: true });
      for (const item of items) {
        if (results.length >= input.maxResults) return;
        if (IGNORED_DIRECTORIES.has(item.name)) continue;
        const absolute = path.join(directory, item.name);
        const relative = path.relative(context.workspacePath, absolute).split(path.sep).join('/');
        if (isIgnoredPath(relative)) continue;
        if (item.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (suffix && !relative.endsWith(suffix)) continue;
        const info = await stat(absolute);
        if (info.size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = await readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        if (content.includes(NUL)) continue;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (results.length >= input.maxResults) break;
          const line = lines[index]!;
          if (pattern.test(line)) {
            results.push(`${relative}:${index + 1}: ${line.trim().slice(0, 300)}`);
          }
        }
      }
    }

    await walk(searchRoot);
    return {
      output: results.length > 0 ? results.join('\n') : `No matches for /${input.query}/`,
      summary: `search "${input.query}" produced ${results.length} matches`,
      metadata: { matches: results.length },
    };
  },
};

interface SearchSymbolsInput {
  name: string;
  maxResults: number;
}

/** Language agnostic declaration search, good enough for impact analysis in v0. */
const SYMBOL_PATTERNS = [
  'class\\s+NAME\\b',
  'interface\\s+NAME\\b',
  'type\\s+NAME\\b',
  'enum\\s+NAME\\b',
  'function\\s+NAME\\b',
  'const\\s+NAME\\b',
  'def\\s+NAME\\b',
  'struct\\s+NAME\\b',
  'func\\s+NAME\\b',
];

export const searchSymbolsTool: ToolSpec<SearchSymbolsInput> = {
  name: 'search_symbols',
  description: 'Find where a class, function, type or constant is declared and where it is used.',
  capability: 'repo.search',
  phases: [...READ_PHASES],
  timeoutMs: 60_000,
  maxOutputChars: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name to look for' },
      maxResults: { type: 'integer' },
    },
    required: ['name'],
  },
  validate(input) {
    return { name: requireString(input, 'name'), maxResults: optionalNumber(input, 'maxResults', 60) };
  },
  async execute(input, context): Promise<ToolResult> {
    const escaped = input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declarationPattern = new RegExp(SYMBOL_PATTERNS.map((entry) => entry.replace('NAME', escaped)).join('|'));
    const usagePattern = new RegExp(`\\b${escaped}\\b`);
    const declarations: string[] = [];
    const usages: string[] = [];

    async function walk(directory: string): Promise<void> {
      const items = await readdir(directory, { withFileTypes: true });
      for (const item of items) {
        if (declarations.length + usages.length >= input.maxResults) return;
        if (IGNORED_DIRECTORIES.has(item.name)) continue;
        const absolute = path.join(directory, item.name);
        const relative = path.relative(context.workspacePath, absolute).split(path.sep).join('/');
        if (item.isDirectory()) {
          await walk(absolute);
          continue;
        }
        const info = await stat(absolute);
        if (info.size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = await readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        if (content.includes(NUL) || !usagePattern.test(content)) continue;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (!usagePattern.test(line)) continue;
          const entry = `${relative}:${index + 1}: ${line.trim().slice(0, 200)}`;
          if (declarationPattern.test(line)) declarations.push(entry);
          else if (usages.length < input.maxResults) usages.push(entry);
        }
      }
    }

    await walk(context.workspacePath);
    const output = [
      `Declarations (${declarations.length}):`,
      declarations.slice(0, 30).join('\n') || '(none found)',
      '',
      `Usages (${usages.length}):`,
      usages.slice(0, input.maxResults).join('\n') || '(none found)',
    ].join('\n');
    return {
      output,
      summary: `symbol ${input.name}: ${declarations.length} declarations, ${usages.length} usages`,
      metadata: { declarations: declarations.length, usages: usages.length },
    };
  },
};

/** Reports how large a file is before an agent decides to read all of it. */
export const fileStatsTool: ToolSpec<{ path: string }> = {
  name: 'file_stats',
  description: 'Return size and line count for a workspace file without reading its content.',
  capability: 'repo.read',
  phases: [...READ_PHASES],
  timeoutMs: 10_000,
  maxOutputChars: 2000,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  validate(input) {
    return { path: requireString(input, 'path') };
  },
  async execute(input, context: ToolContext): Promise<ToolResult> {
    const absolute = assertWorkspacePath(context.workspacePath, input.path);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      return { output: `${input.path} is a directory`, summary: 'directory' };
    }
    const content = await readFile(absolute, 'utf8');
    return {
      output: `${input.path}: ${info.size} bytes, ${countLines(content)} lines, modified ${info.mtime.toISOString()}`,
      summary: `stats for ${input.path}`,
    };
  },
};
