import { AppError, createLogger, loadConfig, retry } from '@ai-engine/shared';
import { parseRemoteUrl, type GitRemoteProvider, type PullRequestInput, type PullRequestResult, type RepositoryMetadata } from './provider';

const logger = createLogger('github');

export class GitHubProvider implements GitRemoteProvider {
  readonly name = 'github';
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;

  constructor(remoteUrl: string, token?: string, apiBaseUrl?: string) {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed) {
      throw new AppError('invalid_remote', `Remote URL is not a GitHub repository: ${remoteUrl}`, 400, { remoteUrl });
    }
    const config = loadConfig();
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.token = token ?? config.github.token;
    this.apiBaseUrl = apiBaseUrl ?? config.github.apiBaseUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) {
      throw new AppError('github_not_configured', 'A GitHub token is required for this operation', 400);
    }
    const response = await retry(
      async () => {
        const result = await fetch(`${this.apiBaseUrl}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'ai-engineering-system',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (result.status >= 500) throw new Error(`GitHub responded with ${result.status}`);
        return result;
      },
      { attempts: 3, onError: (error, attempt) => logger.warn('github request retry', { attempt, error }) },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new AppError('github_request_failed', `GitHub ${method} ${path} failed: ${response.status} ${text}`, response.status);
    }
    return (await response.json()) as T;
  }

  async getRepository(): Promise<RepositoryMetadata> {
    const data = await this.request<{ default_branch: string; html_url: string; private: boolean }>(
      'GET',
      `/repos/${this.owner}/${this.repo}`,
    );
    return {
      owner: this.owner,
      name: this.repo,
      defaultBranch: data.default_branch,
      url: data.html_url,
      private: data.private,
    };
  }

  async getBaseBranchHead(branch: string): Promise<string> {
    const data = await this.request<{ object: { sha: string } }>(
      'GET',
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return data.object.sha;
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const data = await this.request<{ number: number; html_url: string; state: string }>(
      'POST',
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
        draft: input.draft ?? false,
      },
    );
    logger.info('pull request created', { number: data.number, url: data.html_url });
    return { number: data.number, url: data.html_url, state: data.state };
  }

  async findPullRequest(headBranch: string): Promise<PullRequestResult | null> {
    const data = await this.request<{ number: number; html_url: string; state: string }[]>(
      'GET',
      `/repos/${this.owner}/${this.repo}/pulls?head=${encodeURIComponent(`${this.owner}:${headBranch}`)}&state=all`,
    );
    const first = data[0];
    return first ? { number: first.number, url: first.html_url, state: first.state } : null;
  }
}

/** Returns a provider only when the repository actually has a GitHub remote. */
export function createRemoteProvider(remoteUrl: string | null): GitRemoteProvider | null {
  if (!remoteUrl) return null;
  if (!/github\.com/i.test(remoteUrl)) return null;
  try {
    return new GitHubProvider(remoteUrl);
  } catch {
    return null;
  }
}
