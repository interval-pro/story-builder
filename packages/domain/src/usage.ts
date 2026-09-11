/**
 * Usage is counted in tokens, never in money.
 *
 * The engine reports a cost per run and it is still stored, because throwing
 * away a measurement is not reversible, but nothing downstream of the database
 * carries it: the account this runs on is a subscription with a weekly limit, so
 * a dollar figure answers a question nobody here is asking.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * Every token the account was charged for, cache movement included.
 *
 * Cache reads and cache writes are the overwhelming majority of what a task
 * spends, so a total that counts only input and output is not a total. They are
 * kept separate as well, because they are the number the context-size work has
 * to move.
 */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyUsage {
  /** Rolling seven days, not an account billing week: see the note below. */
  since: string;
  until: string;
  usedTokens: number;
  usage: TokenUsage;
  runs: number;
  /** Runs in the window that recorded no usage at all, so the sum is partial. */
  unrecordedRuns: number;
  /** What the owner set as a weekly ceiling, or null when none is set. */
  budgetTokens: number | null;
  /** Whole-number percentage of the budget, or null when no budget is set. */
  percentOfBudget: number | null;
  /**
   * Whatever limit information the engine itself reported, when it reported any.
   *
   * The Claude Code result payload carries no limit field in the version this
   * was written against, so this is normally null and the budget above is a
   * ceiling the owner chose rather than the account's real one. Any payload key
   * that does turn out to carry it is stored and surfaced here unchanged, rather
   * than being summarised into a number that would look authoritative.
   */
  reportedLimit: Record<string, unknown> | null;
}

export function weeklyUsage(input: {
  usage: TokenUsage;
  runs: number;
  unrecordedRuns: number;
  budgetTokens: number | null;
  reportedLimit?: Record<string, unknown> | null;
  now?: number;
}): WeeklyUsage {
  const now = input.now ?? Date.now();
  const used = totalTokens(input.usage);
  return {
    since: new Date(now - WEEK_MS).toISOString(),
    until: new Date(now).toISOString(),
    usedTokens: used,
    usage: input.usage,
    runs: input.runs,
    unrecordedRuns: input.unrecordedRuns,
    budgetTokens: input.budgetTokens,
    percentOfBudget:
      input.budgetTokens && input.budgetTokens > 0 ? Math.round((used / input.budgetTokens) * 100) : null,
    reportedLimit: input.reportedLimit ?? null,
  };
}
