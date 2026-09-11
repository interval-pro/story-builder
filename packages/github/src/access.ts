import { createLogger, loadConfig } from '@ai-engine/shared';
import { parseRemoteUrl } from './provider';

const logger = createLogger('github-access');

export type RemoteAccess = 'UNKNOWN' | 'NONE' | 'READ' | 'WRITE';

/**
 * Whether this installation can actually push to a repository.
 *
 * Asked when a project is added rather than discovered by a push that fails at
 * the very end of a story, which is exactly what used to happen: everything
 * succeeded and then the last step blocked on a credential nobody had checked.
 *
 * A repository with no remote is NONE, which is a complete answer rather than a
 * problem: the story finishes on a local branch. A remote with no token is
 * UNKNOWN, because there is genuinely no way to tell without one, and saying READ
 * would be a guess.
 */
export async function checkRemoteAccess(remoteUrl: string | null, token?: string): Promise<RemoteAccess> {
  if (!remoteUrl) return 'NONE';
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) return 'UNKNOWN';
  if (!token) return 'UNKNOWN';

  const config = loadConfig();
  try {
    const response = await fetch(`${config.github.apiBaseUrl}/repos/${parsed.owner}/${parsed.repo}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'story-builder',
      },
    });
    if (response.status === 404 || response.status === 403) return 'NONE';
    if (!response.ok) return 'UNKNOWN';
    const body = (await response.json()) as { permissions?: { push?: boolean; pull?: boolean } };
    if (body.permissions?.push) return 'WRITE';
    if (body.permissions?.pull) return 'READ';
    // A token that can read the repository but was given no permissions block is
    // a fine-grained one scoped elsewhere: readable, not writable.
    return 'READ';
  } catch (error) {
    logger.warn('could not establish what the token can do with this repository', {
      repo: `${parsed.owner}/${parsed.repo}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'UNKNOWN';
  }
}

/** What the cockpit says about a project, in one sentence. */
export function describeRemoteAccess(access: RemoteAccess, remoteUrl: string | null): string {
  switch (access) {
    case 'WRITE':
      return 'Stories here can push and open a pull request.';
    case 'READ':
      return 'The token can read this repository but not push to it, so stories finish on a local branch.';
    case 'NONE':
      return remoteUrl
        ? 'The token cannot reach this repository, so stories finish on a local branch.'
        : 'This repository has no remote, so stories finish on a local branch.';
    default:
      return 'Whether a push is possible is unknown: add a GitHub token and this is checked again.';
  }
}
