import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRECTORIES } from '@ai-engine/security';

export interface ExtractedEntity {
  kind: string;
  name: string;
  path: string | null;
  signature: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
}

export interface ExtractedEdge {
  from: string;
  to: string;
  relation: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php']);
const SQL_EXTENSIONS = new Set(['.sql']);

const DECLARATION_PATTERNS: { kind: string; regex: RegExp }[] = [
  { kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'type', regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'enum', regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'function', regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(/gm },
  { kind: 'function', regex: /^\s*def\s+([A-Za-z_][\w]*)/gm },
  { kind: 'class', regex: /^\s*class\s+([A-Za-z_][\w]*)/gm },
  { kind: 'function', regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm },
  { kind: 'struct', regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/gm },
];

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm,
  /^\s*(?:const|let|var)\s+[^=]+=\s*require\(['"]([^'"]+)['"]\)/gm,
  /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm,
];

const TABLE_PATTERNS: RegExp[] = [
  /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][\w.]*)/gi,
  /ALTER\s+TABLE\s+([A-Za-z_][\w.]*)/gi,
];

const ENDPOINT_PATTERNS: RegExp[] = [
  /\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g,
  /@(Get|Post|Put|Patch|Delete)\(\s*['"]?([^'")]*)['"]?\s*\)/g,
  /@app\.route\(\s*['"]([^'"]+)['"]/g,
];

async function collectSourceFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    if (files.length >= limit) return;
    let items;
    try {
      items = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (files.length >= limit) return;
      if (IGNORED_DIRECTORIES.has(item.name) || item.name.startsWith('.')) continue;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const extension = path.extname(item.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension) && !SQL_EXTENSIONS.has(extension)) continue;
      const info = await stat(absolute).catch(() => null);
      if (!info || info.size > 1024 * 1024) continue;
      files.push(absolute);
    }
  }

  await walk(root);
  return files;
}

/**
 * Heuristic, language agnostic extraction of the project structure. It is not a
 * compiler; it is a map good enough to reason about blast radius.
 */
export async function extractProjectKnowledge(root: string, options: { maxFiles?: number } = {}): Promise<ExtractionResult> {
  const files = await collectSourceFiles(root, options.maxFiles ?? 4000);
  const entities = new Map<string, ExtractedEntity>();
  const edges: ExtractedEdge[] = [];

  const addEntity = (entity: ExtractedEntity): string => {
    const key = `${entity.kind}:${entity.name}:${entity.path ?? ''}`;
    if (!entities.has(key)) entities.set(key, entity);
    return key;
  };

  const moduleKeys = new Map<string, string>();

  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const directory = path.dirname(relative);
    const content = await readFile(absolute, 'utf8').catch(() => null);
    if (content === null) continue;

    const moduleKey = addEntity({
      kind: 'module',
      name: directory === '.' ? relative : directory,
      path: directory,
      signature: null,
      summary: null,
      metadata: {},
    });
    moduleKeys.set(directory, moduleKey);

    const fileKey = addEntity({
      kind: 'file',
      name: relative,
      path: relative,
      signature: null,
      summary: null,
      metadata: { lines: content.split('\n').length },
    });
    edges.push({ from: moduleKey, to: fileKey, relation: 'CONTAINS' });

    const isTest = /(^|\/)(test|tests|__tests__|spec)\//.test(relative) || /\.(test|spec)\./.test(relative);
    if (isTest) {
      entities.get(fileKey)!.metadata['isTest'] = true;
    }

    const extension = path.extname(relative).toLowerCase();

    if (SQL_EXTENSIONS.has(extension)) {
      for (const pattern of TABLE_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          const tableKey = addEntity({
            kind: 'database_table',
            name: match[1]!,
            path: relative,
            signature: null,
            summary: null,
            metadata: {},
          });
          edges.push({ from: fileKey, to: tableKey, relation: 'DEFINES' });
        }
      }
      continue;
    }

    for (const pattern of DECLARATION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of content.matchAll(pattern.regex)) {
        const name = match[1];
        if (!name || name.length < 2) continue;
        const symbolKey = addEntity({
          kind: pattern.kind,
          name,
          path: relative,
          signature: match[0]?.trim().slice(0, 200) ?? null,
          summary: null,
          metadata: {},
        });
        edges.push({ from: fileKey, to: symbolKey, relation: 'DECLARES' });
        if (isTest) edges.push({ from: fileKey, to: symbolKey, relation: 'COVERS' });
      }
    }

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier || !specifier.startsWith('.')) continue;
        const targetDirectory = path.normalize(path.join(directory, path.dirname(specifier)));
        const targetKey = moduleKeys.get(targetDirectory);
        if (targetKey && targetKey !== moduleKey) {
          edges.push({ from: moduleKey, to: targetKey, relation: 'DEPENDS_ON', metadata: { specifier } });
        }
      }
    }

    for (const pattern of ENDPOINT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const route = match[2] ?? match[1];
        if (!route || !route.startsWith('/')) continue;
        const method = (match[2] ? match[1] : 'ANY') ?? 'ANY';
        const endpointKey = addEntity({
          kind: 'endpoint',
          name: `${method.toUpperCase()} ${route}`,
          path: relative,
          signature: null,
          summary: null,
          metadata: {},
        });
        edges.push({ from: fileKey, to: endpointKey, relation: 'EXPOSES' });
      }
    }
  }

  return { entities: [...entities.values()], edges: dedupeEdges(edges, entities) };
}

function dedupeEdges(edges: ExtractedEdge[], entities: Map<string, ExtractedEntity>): ExtractedEdge[] {
  const seen = new Set<string>();
  const result: ExtractedEdge[] = [];
  for (const edge of edges) {
    if (!entities.has(edge.from) || !entities.has(edge.to)) continue;
    const key = `${edge.from}|${edge.to}|${edge.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

/** Compact description of the project structure for agent prompts. */
export function summarizeExtraction(result: ExtractionResult): string {
  const counts = new Map<string, number>();
  for (const entity of result.entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  const countLine = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');

  const topModules = result.entities
    .filter((entity) => entity.kind === 'module')
    .slice(0, 25)
    .map((entity) => `- ${entity.name}`)
    .join('\n');

  const tables = result.entities
    .filter((entity) => entity.kind === 'database_table')
    .slice(0, 30)
    .map((entity) => entity.name)
    .join(', ');

  const endpoints = result.entities
    .filter((entity) => entity.kind === 'endpoint')
    .slice(0, 30)
    .map((entity) => entity.name)
    .join(', ');

  return [
    `Structure: ${countLine || 'nothing extracted'}`,
    topModules ? `\nModules:\n${topModules}` : '',
    tables ? `\nDatabase tables: ${tables}` : '',
    endpoints ? `\nEndpoints: ${endpoints}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
