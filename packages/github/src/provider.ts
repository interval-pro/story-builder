export interface PullRequestInput {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  draft?: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
  state: string;
}

export interface RepositoryMetadata {
  owner: string;
  name: string;
  defaultBranch: string;
  url: string;
  private: boolean;
}

/**
 * Only GitHub is implemented in v0, but the seam is kept so another forge can
 * be added without touching the orchestrator.
 */
export interface GitRemoteProvider {
  readonly name: string;
  isConfigured(): boolean;
  getRepository(): Promise<RepositoryMetadata>;
  getBaseBranchHead(branch: string): Promise<string>;
  createPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
  findPullRequest(headBranch: string): Promise<PullRequestResult | null>;
}

/** Parses owner and repository out of both SSH and HTTPS remotes. */
export function parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
  const ssh = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/);
  if (ssh) return { owner: ssh[2]!, repo: ssh[3]! };
  const https = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(\.git)?$/);
  if (https) return { owner: https[1]!, repo: https[2]! };
  return null;
}
