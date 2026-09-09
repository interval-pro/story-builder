import { createLogger, loadConfig } from '@ai-engine/shared';
import { parseRemoteUrl } from './provider';

const logger = createLogger('github-releases');

export interface ReleaseInfo {
  tag: string;
  url: string;
  publishedAt: string | null;
}

/**
 * Reads the newest published release of a repository. A token is used when one
 * is configured but is not required, so a fresh install can look up its own
 * upstream before anything has been authenticated.
 */
export async function fetchLatestRelease(remoteUrl: string, token?: string): Promise<ReleaseInfo | null> {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) return null;
  const config = loadConfig();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-engineering-system',
  };
  const authorization = token ?? config.github.token;
  if (authorization) headers['Authorization'] = `Bearer ${authorization}`;

  try {
    const response = await fetch(`${config.github.apiBaseUrl}/repos/${parsed.owner}/${parsed.repo}/releases/latest`, {
      headers,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      logger.warn('could not read the latest release', { status: response.status });
      return null;
    }
    const data = (await response.json()) as { tag_name?: string; html_url?: string; published_at?: string };
    if (!data.tag_name) return null;
    return { tag: data.tag_name, url: data.html_url ?? '', publishedAt: data.published_at ?? null };
  } catch (error) {
    logger.warn('could not reach GitHub for the latest release', { error: String(error) });
    return null;
  }
}
