import type { QaFinding, QaNote } from './entities';

/**
 * Which QA findings are still open, across every iteration.
 *
 * Reading only the latest QA run is wrong in a way that cost real defects. Two
 * passes over nearly the same diff produced disjoint blocking findings, which
 * means one pass does not find everything; and a QA run that is a re-run rather
 * than a check of a fix supersedes findings nobody addressed. A merged change
 * shipped carrying a verified defect that way, while the record looked complete.
 *
 * The rule that distinguishes the two cases is whether an implementation actually
 * ran in between:
 *
 * - A fix ran between the two QA runs, so the later run looked at changed code.
 *   Anything it does not raise again is presumed dealt with.
 * - No fix ran, so the later run looked at the same code. It is a second opinion,
 *   not a replacement, and the earlier findings stand alongside its own.
 *
 * An APPROVED verdict clears everything: the agent whose job is to reject this
 * change has declined to, and carrying findings past that would make approval
 * mean nothing.
 */
export interface QaIterationRecord {
  iteration: number;
  verdict: 'APPROVED' | 'REJECTED' | 'BLOCKED';
  findings: QaFinding[];
  notes?: QaNote[];
  createdAt: string;
}

/** Same defect, reported twice. File and summary are what a person compares. */
function findingKey(finding: QaFinding): string {
  return `${finding.file ?? ''}::${finding.summary.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function happenedBetween(times: string[], after: string, before: string): boolean {
  const from = Date.parse(after);
  const to = Date.parse(before);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return times.some((time) => {
    const at = Date.parse(time);
    return Number.isFinite(at) && at > from && at < to;
  });
}

export function carryOpenFindings(input: {
  qaRuns: QaIterationRecord[];
  /** When an implementation or fix run finished, in any order. */
  fixTimes: string[];
}): QaFinding[] {
  const ordered = [...input.qaRuns].sort((a, b) => a.iteration - b.iteration);
  let open = new Map<string, QaFinding>();

  for (const [index, run] of ordered.entries()) {
    const previous = index > 0 ? ordered[index - 1] : undefined;
    const fixedSincePrevious = previous
      ? happenedBetween(input.fixTimes, previous.createdAt, run.createdAt)
      : false;

    // A run that followed a fix judged different code, so what it stays silent
    // about is presumed addressed. A run that followed no fix judged the same
    // code, and its silence says nothing.
    if (fixedSincePrevious) open = new Map();

    for (const finding of run.findings) {
      open.set(findingKey(finding), { ...finding, status: 'OPEN' });
    }

    if (run.verdict === 'APPROVED') open = new Map();
  }

  return [...open.values()];
}

/**
 * Every remark QA has made, de-duplicated.
 *
 * Notes are advisory and cheap to carry, so they are not cleared by a fix the way
 * findings are: a remark about the shape of a test is still true after the test
 * was changed for another reason, and the cost of repeating it is one line.
 */
export function collectQaNotes(qaRuns: QaIterationRecord[]): QaNote[] {
  const seen = new Map<string, QaNote>();
  for (const run of qaRuns) {
    for (const note of run.notes ?? []) {
      seen.set(`${note.file ?? ''}::${note.summary.trim().toLowerCase()}`, note);
    }
  }
  return [...seen.values()];
}
