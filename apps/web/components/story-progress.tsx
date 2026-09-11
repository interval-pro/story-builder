'use client';

import type { TaskProgress } from '../lib/api';
import { formatDuration, formatStamp } from '../lib/format';
import { Bar, Card } from './ui';

const MARKS: Record<string, string> = {
  DONE: '✓',
  RUNNING: '•',
  WAITING: '?',
  BLOCKED: '!',
  FAILED: '!',
  PENDING: '',
  SKIPPED: '–',
};

/**
 * Where the story has got to, as a walk rather than a state name.
 *
 * The three tabs this replaces could each tell you about their own phase and
 * nothing about the shape of the whole thing: which steps had happened, which
 * were skipped, how long each took, and which one is waiting on you. That is one
 * question, so it gets one answer.
 */
export function StoryProgress({ progress }: { progress: TaskProgress }) {
  const current = progress.currentIndex >= 0 ? progress.steps[progress.currentIndex] : undefined;

  return (
    <Card>
      <div className="row-between">
        <div className="col">
          <span className="meta">Progress</span>
          <span className="list-title">
            {current
              ? `${current.label}${current.needsYou ? ' — waiting for you' : ''}`
              : progress.percent === 100
                ? 'Finished'
                : 'Not started'}
          </span>
        </div>
        <div className="col" style={{ alignItems: 'flex-end' }}>
          <span className="meta">
            {progress.percent}% · {formatDuration(progress.elapsedMs)} in total
          </span>
          {current && progress.currentForMs !== null ? (
            <span className="meta">in this step for {formatDuration(progress.currentForMs)}</span>
          ) : null}
        </div>
      </div>

      <Bar
        percent={progress.percent}
        tone={current?.status === 'BLOCKED' || current?.status === 'FAILED' ? 'critical' : undefined}
      />

      <div className="steps">
        {progress.steps.map((step) => (
          <div key={step.key} className={`step ${step.status.toLowerCase()}`}>
            <span className="step-mark" aria-hidden>
              {MARKS[step.status] ?? ''}
            </span>
            <div className="grow">
              <div className="step-name">{step.label}</div>
              <div className="body-sm">{step.detail || step.purpose}</div>
            </div>
            <div className="step-times">
              {step.startedAt ? (
                <>
                  {formatStamp(step.startedAt)}
                  <br />
                  {step.finishedAt ? `${formatStamp(step.finishedAt)} · ` : 'running · '}
                  {formatDuration(step.durationMs)}
                </>
              ) : step.status === 'WAITING' ? (
                'waiting for you'
              ) : step.status === 'SKIPPED' ? (
                'not needed'
              ) : (
                'not yet'
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
