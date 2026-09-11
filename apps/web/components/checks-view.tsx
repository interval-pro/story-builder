'use client';

import { Badge, Card, Empty, VerdictBadge } from './ui';
import { severityTone } from '../lib/labels';

interface QaFinding {
  id: string;
  severity: string;
  category: string;
  summary: string;
  detail: string;
  suggestedFix?: string;
  file: string | null;
}

interface QaNote {
  summary: string;
  detail: string;
  file: string | null;
}

interface QaRun {
  id: string;
  iteration: number;
  verdict: string;
  findings: QaFinding[];
  notes?: QaNote[];
}

/**
 * What the checks found, across every iteration.
 *
 * Every iteration is shown rather than only the latest. Two passes over nearly
 * the same diff once produced disjoint blocking findings, which means one pass
 * does not find everything; showing only the newest hid the earlier ones and a
 * verified defect shipped that way.
 */
export function ChecksView({ qaRuns, maxIterations }: { qaRuns: QaRun[]; maxIterations: number }) {
  if (qaRuns.length === 0) {
    return (
      <Card>
        <span className="meta">Checks</span>
        <Empty>
          Nothing has been checked yet. Once the change is written, a separate agent reviews the diff and runs the tests
          without seeing the reasoning behind it.
        </Empty>
      </Card>
    );
  }

  const latest = qaRuns[qaRuns.length - 1]!;

  return (
    <div className="stack">
      <Card>
        <div className="row-between">
          <div className="col">
            <span className="meta">Latest check · iteration {latest.iteration}</span>
            <div className="row" style={{ marginTop: 8 }}>
              <VerdictBadge verdict={latest.verdict} />
              <span className="meta">
                {latest.findings.length} finding(s){latest.notes?.length ? ` · ${latest.notes.length} note(s)` : ''}
              </span>
            </div>
          </div>
          <div className="col" style={{ alignItems: 'flex-end' }}>
            <span className="meta">Fix cycles used</span>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              {Array.from({ length: maxIterations }, (_, index) => (
                <span
                  key={index}
                  style={{
                    width: 28,
                    height: 6,
                    borderRadius: 3,
                    background: index < qaRuns.length ? 'var(--orange-550)' : 'rgba(242,229,200,0.12)',
                  }}
                />
              ))}
            </div>
            <span className="meta" style={{ marginTop: 8 }}>
              {qaRuns.length} of {maxIterations}, then it waits for you
            </span>
          </div>
        </div>
        <p className="body-sm">
          A check that sends the change back is the ordinary outcome of a first pass, not a verdict on the work. What
          matters is whether the findings are real and whether they get fixed.
        </p>
      </Card>

      {qaRuns
        .slice()
        .reverse()
        .map((run) => (
          <section className="stack" key={run.id}>
            <div className="row-between">
              <h3 className="subhead">Iteration {run.iteration}</h3>
              <VerdictBadge verdict={run.verdict} />
            </div>

            {run.findings.length === 0 ? (
              <Empty>This pass found nothing to fix.</Empty>
            ) : (
              run.findings.map((finding) => (
                <div
                  key={finding.id}
                  className="card"
                  style={{
                    borderLeft: `4px solid ${
                      severityTone(finding.severity) === 'critical'
                        ? 'var(--status-critical)'
                        : severityTone(finding.severity) === 'caution'
                          ? 'var(--status-caution)'
                          : 'var(--line-hairline)'
                    }`,
                    borderRadius: '0 var(--radius-surface) var(--radius-surface) 0',
                  }}
                >
                  <div className="row">
                    <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                    <Badge>{finding.category.replace(/_/g, ' ')}</Badge>
                  </div>
                  <div className="list-title">{finding.summary}</div>
                  {finding.file ? <div className="mono">{finding.file}</div> : null}
                  <div className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                    {finding.detail}
                  </div>
                  {finding.suggestedFix ? (
                    <div className="body-sm">Suggested: {finding.suggestedFix}</div>
                  ) : null}
                </div>
              ))
            )}

            {run.notes && run.notes.length > 0 ? (
              <Card tone="plain">
                <span className="meta">Noted, not blocked on</span>
                {run.notes.map((note) => (
                  <div className="body-sm" key={note.summary} style={{ color: 'var(--ivory-100)' }}>
                    — {note.summary}
                    {note.file ? ` (${note.file})` : ''}
                    {note.detail ? `: ${note.detail}` : ''}
                  </div>
                ))}
              </Card>
            ) : null}
          </section>
        ))}
    </div>
  );
}
