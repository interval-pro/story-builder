import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger, loadConfig } from '@ai-engine/shared';

const logger = createLogger('prompt-loader');

export type AgentType = 'research' | 'review' | 'implementation' | 'qa' | 'learning';

/**
 * Agent instructions are version controlled inside the repository, so a system
 * story can change how an agent thinks without changing any code.
 */
const FALLBACK_PROMPTS: Record<AgentType, string> = {
  research:
    '# Research Agent\n\nYou are the Research Agent. Understand the story and the repository. ' +
    'You have no write access and you never propose a solution. Every claim must come from code ' +
    'you actually read, and anything you could not establish belongs in the open questions.',
  review:
    '# Engineering Review Agent\n\nYou are the Engineering Review Agent. Turn research findings into ' +
    'an engineering review. Give exactly one recommended approach, always state its downsides, and ' +
    'never use confidence percentages. Human notes are corrections, not suggestions.',
  implementation:
    '# Implementation Agent\n\nYou are the Implementation Agent. Implement exactly the approved review ' +
    'inside the task sandbox. Never silently widen the approved scope; report anything the human did ' +
    'not approve as a discovered issue. Verify the build and tests before reporting success.',
  qa:
    '# QA Agent\n\nYou are the QA Agent. Review the diff independently for correctness, regressions, ' +
    'edge cases, security, invariants, architecture, migrations and test quality. Every finding needs ' +
    'a concrete failure scenario.',
  learning:
    '# Learning Agent\n\nYou are the Learning Agent. Extract the generalised engineering principle ' +
    'behind each human correction, not the correction itself.',
};

const cache = new Map<string, { content: string; loadedAt: number }>();
const CACHE_TTL_MS = 30_000;

export function agentPromptPath(type: AgentType, projectRoot?: string): string {
  const root = projectRoot ?? loadConfig().paths.projectRoot;
  return path.join(root, '.ai-engineering', 'agents', `${type}.md`);
}

/** Reads the agent definition from the repository, falling back to the built-in text. */
export async function loadAgentPrompt(type: AgentType, projectRoot?: string): Promise<string> {
  const filePath = agentPromptPath(type, projectRoot);
  const cached = cache.get(filePath);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.content;
  try {
    const content = await readFile(filePath, 'utf8');
    cache.set(filePath, { content, loadedAt: Date.now() });
    return content;
  } catch {
    logger.warn('agent definition not found, using the built-in prompt', { type, filePath });
    return FALLBACK_PROMPTS[type];
  }
}

export function clearPromptCache(): void {
  cache.clear();
}
