import { AppError } from '@ai-engine/shared';
import { mergeUsage, type PassUsage } from './usage';
import type { ClaudeResult } from './types';

/** What one pass spent, in the shape the merge works on. */
export function passUsage(result: ClaudeResult): PassUsage {
  return {
    usage: result.usage,
    costUsd: result.costUsd,
    modelUsage: result.modelUsage,
    subagentStats: result.subagentStats,
  };
}

/**
 * Re-throws an answer-pass failure carrying what both passes spent.
 *
 * An agent run is two passes over one session: the work pass explores with tools,
 * then a resumed pass writes the answer with every tool switched off. The work
 * pass is the expensive half by a long way — it is the one that read the
 * repository and filled the session.
 *
 * When the answer pass then fails, the handler's catch reads the usage off the
 * error. Without this it would find only the answer pass's own partial numbers,
 * or none at all, and the run would be recorded as having spent a few hundred
 * tokens on work that cost tens of thousands.
 *
 * It lives in its own module rather than beside the runner so a test can import
 * it: the runner uses constructor parameter properties, which Node's type
 * stripping refuses to load.
 */
export function withWorkPassSpend(error: unknown, work: ClaudeResult): unknown {
  if (!(error instanceof AppError)) return error;
  const details = error.details ?? {};
  const answerUsage = details['usage'] as ClaudeResult['usage'] | undefined;
  const merged = mergeUsage(passUsage(work), {
    usage: answerUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: typeof details['costUsd'] === 'number' ? (details['costUsd'] as number) : 0,
    modelUsage: (details['modelUsage'] as Record<string, unknown> | null) ?? null,
    subagentStats: (details['subagentStats'] as Record<string, unknown> | null) ?? null,
  });
  return new AppError(error.code, error.message, error.status, {
    ...details,
    sessionId: work.sessionId || details['sessionId'] || null,
    usage: merged.usage,
    costUsd: merged.costUsd,
    modelUsage: merged.modelUsage,
    subagentStats: merged.subagentStats,
  });
}
