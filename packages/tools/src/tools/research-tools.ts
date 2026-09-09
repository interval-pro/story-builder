import { containsSecret } from '@ai-engine/security';
import { TimeoutError, withTimeout } from '@ai-engine/shared';
import type { ToolResult, ToolSpec } from '../types';
import { optionalString, requireString } from '../types';

/**
 * Trust hierarchy from the network policy. Community sources are never treated
 * as truth on their own; the model is told where the information came from.
 */
const TRUST_TIERS: { tier: number; label: string; test: (host: string) => boolean }[] = [
  { tier: 1, label: 'official documentation', test: (host) => /(^|\.)(docs?|developer|learn)\./.test(host) },
  { tier: 2, label: 'official release notes', test: (host) => /(^|\.)(github\.com|gitlab\.com)$/.test(host) },
  { tier: 3, label: 'issue tracker or discussion', test: (host) => /(^|\.)(github\.com|gitlab\.com|issues\.)/.test(host) },
  { tier: 4, label: 'stack overflow', test: (host) => /stackoverflow\.com$/.test(host) },
  { tier: 5, label: 'community source', test: () => true },
];

function classify(url: string): { tier: number; label: string } {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const match = TRUST_TIERS.find((entry) => entry.test(host));
    return { tier: match?.tier ?? 5, label: match?.label ?? 'community source' };
  } catch {
    return { tier: 5, label: 'community source' };
  }
}

/** Removes markup so a page can be handed to a model as plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

interface ResearchWebInput {
  url?: string;
  query?: string;
  purpose: string;
}

export const researchWebTool: ToolSpec<ResearchWebInput> = {
  name: 'research_web',
  description:
    'Fetch an external page, or search the web, to check external facts such as library behaviour. Results are labelled with a trust tier and must always be validated against the repository.',
  capability: 'web.research',
  phases: ['RESEARCH', 'REVIEW'],
  timeoutMs: 60_000,
  maxOutputChars: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Page to fetch' },
      query: { type: 'string', description: 'Search query, used when no URL is known' },
      purpose: { type: 'string', description: 'What this lookup is meant to establish' },
    },
    required: ['purpose'],
  },
  validate(input) {
    const url = optionalString(input, 'url');
    const query = optionalString(input, 'query');
    if (!url && !query) throw new Error('research_web requires either a url or a query');
    if (url && !/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs are supported');
    const purpose = requireString(input, 'purpose');
    if (containsSecret(purpose) || (query ? containsSecret(query) : false)) {
      throw new Error('Project secrets must never be sent to external services');
    }
    return { url, query, purpose };
  },
  async execute(input, context): Promise<ToolResult> {
    if (!context.allowWeb) {
      return { output: 'Web research is disabled for this task.', summary: 'web research disabled', isError: true };
    }

    const target = input.url ?? `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query ?? '')}`;
    const response = await withTimeout(
      fetch(target, { headers: { 'user-agent': 'ai-engineering-system/0.1 (research agent)' } }),
      45_000,
      () => new TimeoutError('web research', 45_000),
    );
    if (!response.ok) {
      return { output: `Request failed with status ${response.status}`, summary: `fetch failed ${response.status}`, isError: true };
    }
    const html = await response.text();
    const text = htmlToText(html);
    const trust = classify(target);
    const header = [
      `Source: ${target}`,
      `Trust tier: ${trust.tier} (${trust.label})`,
      `Purpose: ${input.purpose}`,
      'Community sources must be validated against the repository, its dependency versions and the official documentation.',
      '',
    ].join('\n');
    return {
      output: header + text,
      summary: `fetched ${target} (tier ${trust.tier})`,
      metadata: { url: target, trustTier: trust.tier },
    };
  },
};
