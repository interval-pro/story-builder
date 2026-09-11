import { HttpRouter } from '@ai-engine/shared';
import {
  addTokenUsage,
  emptyTokenUsage,
  SETTING_KEYS,
  totalTokens,
  weeklyUsage,
  WEEK_MS,
} from '@ai-engine/domain';
import type { AgentUsage } from '@ai-engine/db';
import type { ApiContext } from '../context';

function sum(rows: AgentUsage[]): { usage: ReturnType<typeof emptyTokenUsage>; runs: number; unrecorded: number; failed: number } {
  return rows.reduce(
    (total, row) => ({
      usage: addTokenUsage(total.usage, {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      }),
      runs: total.runs + row.runs,
      unrecorded: total.unrecorded + row.unrecordedRuns,
      failed: total.failed + row.failedRuns,
    }),
    { usage: emptyTokenUsage(), runs: 0, unrecorded: 0, failed: 0 },
  );
}

/**
 * What the agents have used, in tokens.
 *
 * There is no money in this response. The engine reports a cost per run and the
 * column keeps it, because discarding a measurement cannot be undone, but the
 * account this runs on is a subscription with a weekly limit: a dollar figure
 * answers a question nobody is asking and invites being read as the bill.
 *
 * The week is a rolling seven days across every project, because that is what an
 * account limit applies to. The budget it is measured against is one the owner
 * set, not the account's own — the engine reports no limit field, so nothing here
 * can know it, and the response says as much rather than implying otherwise.
 */
export function registerUsageRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/usage', async ({ query }) => {
    const projectId = query.get('projectId');
    const requestedHours = Number.parseFloat(query.get('windowHours') ?? '');
    const windowHours = Number.isFinite(requestedHours) && requestedHours > 0 ? requestedHours : 24;
    const since = new Date(Date.now() - windowHours * 3_600_000);

    const [windowRows, weekRows, budget] = await Promise.all([
      context.repos.runs.usageSince(projectId, since),
      // Always every project: the limit is on the account, not on a repository.
      context.repos.runs.usageSince(null, new Date(Date.now() - WEEK_MS)),
      context.repos.settings.integer(SETTING_KEYS.weeklyTokenBudget),
    ]);

    const windowTotal = sum(windowRows);
    const weekTotal = sum(weekRows);

    return {
      window: {
        hours: windowHours,
        since: since.toISOString(),
        until: new Date().toISOString(),
        projectId: projectId ?? null,
        usage: windowTotal.usage,
        totalTokens: totalTokens(windowTotal.usage),
        runs: windowTotal.runs,
        unrecordedRuns: windowTotal.unrecorded,
        failedRuns: windowTotal.failed,
        byAgent: windowRows.map((row) => ({
          ...row,
          totalTokens: totalTokens({
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheCreationTokens: row.cacheCreationTokens,
          }),
        })),
      },
      week: weeklyUsage({
        usage: weekTotal.usage,
        runs: weekTotal.runs,
        unrecordedRuns: weekTotal.unrecorded,
        budgetTokens: budget > 0 ? budget : null,
      }),
      provenance: {
        perRun: 'measured: the token counts the engine itself reported',
        window: 'derived: our sum of those counts over a range we chose',
        limit: 'self-set: the engine reports no account limit, so the budget is one you configured',
      },
    };
  });
}
