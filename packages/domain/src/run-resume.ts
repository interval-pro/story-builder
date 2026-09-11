import type { TaskRun } from './entities';

/**
 * How long after a run failed its session is still worth resuming.
 *
 * One hour is the prompt cache lifetime on a Claude subscription, which is what
 * this installation runs on. Past it the cached prefix is gone, so resuming buys
 * nothing a cold start would not also pay for.
 *
 * If this is ever pointed at an API key, where the cache lifetime is minutes
 * rather than an hour, this number is wrong and every resume inside the window
 * is a wasted attempt. Nothing else in the repository records which of the two
 * it runs on, which is why the assumption is written here beside the value
 * rather than left to be inferred from it.
 */
export const RESUMABLE_WINDOW_MS = 60 * 60 * 1000;

/**
 * A run that ran out of time rather than failing outright.
 *
 * The only trace of it on the row is the message the CLI timeout put there, so
 * this matches that message. The distinction is worth the coupling: a timed-out
 * session spent its entire budget, and resuming it starts a conversation that
 * has already proven it cannot finish in the time allowed.
 */
const TIMEOUT_MARKER = 'did not finish within';

/** What the heuristic needs off a run. Kept narrow so a test can build one. */
export type ResumeCandidate = Pick<TaskRun, 'status' | 'sessionId' | 'finishedAt' | 'errorMessage'>;

/**
 * Whether a retry should continue this run's session instead of starting cold.
 *
 * The attempt itself is the real test of whether a session can still be read
 * back; this is only the cheap pre-filter that stops us paying for that attempt
 * on a run that failed last week. The two errors cost very differently — a
 * wasted resume is one fast rejection, while a needless cold start is the whole
 * re-read — so anything uncertain resolves towards attempting it, except the
 * cases below where there is nothing to attempt.
 */
export function shouldResumeFailedRun(run: ResumeCandidate | null, now: Date): boolean {
  if (!run) return false;
  if (run.status !== 'FAILED') return false;
  if (!run.sessionId) return false;
  if (run.errorMessage?.includes(TIMEOUT_MARKER)) return false;

  // failStaleRuns cannot leave a FAILED run without a finish time, but a crash
  // mid-write could. An unreadable timestamp is treated as outside the window:
  // starting cold costs a re-read, resuming a session that is long gone costs a
  // job attempt, and only one of those recovers on its own.
  if (!run.finishedAt) return false;
  const finishedAt = new Date(run.finishedAt).getTime();
  if (!Number.isFinite(finishedAt)) return false;

  const age = now.getTime() - finishedAt;
  return age >= 0 && age <= RESUMABLE_WINDOW_MS;
}
