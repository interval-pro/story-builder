import { GitClient } from './git-client';

export interface FileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  insertions: number;
  deletions: number;
}

const CHANGE_TYPES: Record<string, FileChange['changeType']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
};

/** Structured summary of what a task changed relative to its base commit. */
export async function changedFiles(git: GitClient, baseRef: string, headRef = 'HEAD'): Promise<FileChange[]> {
  const numstat = await git.run(['diff', '--numstat', baseRef, headRef], { allowFailure: true });
  const nameStatus = await git.run(['diff', '--name-status', baseRef, headRef], { allowFailure: true });
  if (numstat.exitCode !== 0) return [];

  const types = new Map<string, FileChange['changeType']>();
  for (const line of nameStatus.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const marker = (parts[0] ?? '').charAt(0);
    const filePath = parts[parts.length - 1] ?? '';
    types.set(filePath, CHANGE_TYPES[marker] ?? 'modified');
  }

  const changes: FileChange[] = [];
  for (const line of numstat.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [insertions = '0', deletions = '0', filePath = ''] = parts;
    changes.push({
      filePath,
      changeType: types.get(filePath) ?? 'modified',
      insertions: insertions === '-' ? 0 : Number.parseInt(insertions, 10) || 0,
      deletions: deletions === '-' ? 0 : Number.parseInt(deletions, 10) || 0,
    });
  }
  return changes;
}

/** The complete change set of a task, including work that is not committed yet. */
export async function fullDiff(git: GitClient, baseRef: string, headRef = 'HEAD'): Promise<string> {
  const committed = await git.run(['diff', baseRef, headRef], { allowFailure: true });
  const uncommitted = await git.run(['diff', 'HEAD'], { allowFailure: true });
  const untracked = await git.run(['ls-files', '--others', '--exclude-standard'], { allowFailure: true });

  const parts = [committed.stdout];
  if (uncommitted.stdout.trim()) parts.push('\n--- Uncommitted working tree changes ---\n', uncommitted.stdout);
  if (untracked.stdout.trim()) parts.push('\n--- Untracked files ---\n', untracked.stdout);
  return parts.join('');
}

/** Diff limited to a set of files, used when a QA finding points at one file. */
export async function diffForFiles(git: GitClient, baseRef: string, files: string[]): Promise<string> {
  if (files.length === 0) return '';
  const result = await git.run(['diff', baseRef, 'HEAD', '--', ...files], { allowFailure: true });
  return result.stdout;
}

export function summarizeChanges(changes: FileChange[]): string {
  if (changes.length === 0) return 'No files changed.';
  const insertions = changes.reduce((sum, change) => sum + change.insertions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  return `${changes.length} file(s) changed, ${insertions} insertion(s), ${deletions} deletion(s)`;
}
