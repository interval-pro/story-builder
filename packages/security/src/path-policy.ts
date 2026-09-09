import path from 'node:path';
import { PermissionDeniedError } from '@ai-engine/shared';

/** Paths agents may never read, because they hold credentials or noise. */
const DENIED_SEGMENTS = ['.git/config', '.git/credentials', '.npmrc', '.netrc', '.ssh', 'id_rsa', '.aws'];
const DENIED_FILES = ['.env', '.env.local', '.env.production'];

export interface PathCheck {
  allowed: boolean;
  reason?: string;
  absolutePath: string;
}

/**
 * Resolves a tool supplied path inside the task workspace and refuses anything
 * that escapes it. Agents never address the host filesystem directly.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): PathCheck {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
    return { allowed: false, reason: 'Path escapes the task workspace', absolutePath };
  }
  const relative = path.relative(root, absolutePath);
  const normalized = relative.split(path.sep).join('/');
  const base = path.basename(absolutePath);
  if (DENIED_FILES.includes(base)) {
    return { allowed: false, reason: `${base} may contain secrets and is not readable by agents`, absolutePath };
  }
  for (const segment of DENIED_SEGMENTS) {
    if (normalized === segment || normalized.includes(`${segment}/`) || normalized.endsWith(`/${segment}`)) {
      return { allowed: false, reason: `Path segment "${segment}" is not accessible to agents`, absolutePath };
    }
  }
  return { allowed: true, absolutePath };
}

export function assertWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const check = resolveWorkspacePath(workspaceRoot, relativePath);
  if (!check.allowed) {
    throw new PermissionDeniedError(check.reason ?? 'Path is not accessible', { relativePath });
  }
  return check.absolutePath;
}

/** Directories that are never worth searching or reading. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.turbo',
  '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.gradle', '.idea', '.vscode',
  '.ai-workspaces', '.artifacts',
]);

export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment));
}
