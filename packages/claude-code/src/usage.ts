import type { ClaudeResult } from './types';

/** What one CLI invocation reported spending. */
export interface PassUsage {
  usage: ClaudeResult['usage'];
  costUsd: number;
  modelUsage: Record<string, unknown> | null;
  subagentStats: Record<string, unknown> | null;
}

function readObject(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = raw[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Per-model token counts from the result payload. The CLI mixes camelCase and
 * snake_case across versions, so both spellings are read; an absent key is null
 * rather than an empty object, because "nothing recorded" and "no models used"
 * are different facts.
 */
export function readModelUsage(raw: Record<string, unknown>): Record<string, unknown> | null {
  return readObject(raw, ['modelUsage', 'model_usage']);
}

/**
 * What the run spent on subagents. This is the only direct evidence that the
 * delegation denial held, so it is stored rather than summarised away.
 */
export function readSubagentStats(raw: Record<string, unknown>): Record<string, unknown> | null {
  return readObject(raw, ['subagentStats', 'subagent_stats']);
}

/**
 * Merges two JSON objects of unspecified shape by summing their numeric leaves.
 * A non-numeric leaf is kept from the first side rather than coerced, so a
 * string value never becomes NaN in the row we store.
 */
function mergeJson(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!a) return b;
  if (!b) return a;
  const merged: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = merged[key];
    if (existing === undefined) {
      merged[key] = value;
    } else if (typeof existing === 'number' && typeof value === 'number') {
      merged[key] = existing + value;
    } else if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeJson(existing, value);
    }
    // Anything else keeps the first side's value.
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Adds up what the two passes of one agent run spent. The passes resume one
 * session, so this assumes they report disjoint numbers; if the resumed pass
 * ever re-reports the prefix the first one paid for, the cache figures are
 * inflated and the fix is here rather than spread over the handlers.
 */
export function mergeUsage(a: PassUsage, b: PassUsage): PassUsage {
  return {
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      cacheReadTokens: a.usage.cacheReadTokens + b.usage.cacheReadTokens,
      cacheCreationTokens: a.usage.cacheCreationTokens + b.usage.cacheCreationTokens,
    },
    costUsd: a.costUsd + b.costUsd,
    modelUsage: mergeJson(a.modelUsage, b.modelUsage),
    subagentStats: mergeJson(a.subagentStats, b.subagentStats),
  };
}
