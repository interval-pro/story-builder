'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Card, Empty, Loading } from './ui';
import { formatStamp } from '../lib/format';
import { loadPhase } from '../lib/load-state';

interface SystemEvent {
  eventId: string;
  eventType: string;
  actorType: string;
  actorId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const ACTOR_TONES: Record<string, 'waiting' | 'running' | 'done'> = {
  human: 'waiting',
  agent: 'done',
  orchestrator: 'running',
  worker: 'running',
  system: 'running',
};

/** A plain sentence for the events a person actually reads. */
function describe(event: SystemEvent): string {
  const payload = event.payload;
  switch (event.eventType) {
    case 'TaskStateChanged':
      return `${String(payload['from'] ?? '?')} → ${String(payload['to'] ?? '?')}${
        payload['reason'] ? ` (${String(payload['reason'])})` : ''
      }`;
    case 'ToolCalled':
      return `used ${String(payload['tool'] ?? 'a tool')}`;
    case 'FileModified':
      return `changed ${String(payload['path'] ?? 'a file')}`;
    case 'TestPassed':
      return `tests passed: ${String(payload['command'] ?? '')}`;
    case 'TestFailed':
      return `tests failed: ${String(payload['command'] ?? '')}`;
    case 'HumanNoteAdded':
      return payload['decision'] ? `answered "${String(payload['decision'])}"` : 'left a note on the plan';
    case 'PRCreated':
      return `opened pull request ${String(payload['number'] ?? '')}`;
    default:
      return event.eventType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }
}

/**
 * Every transition, appended and never edited.
 *
 * This is the record a crashed worker is replaceable against: the log is the
 * truth, not the process that wrote it.
 */
export function TimelineView({ taskId }: { taskId: string }) {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const result = await api.get<{ events: SystemEvent[] }>(`/api/tasks/${taskId}/events?limit=300`);
        setEvents(result.events);
        setLoadedFor(taskId);
        setError(null);
      } catch (loadError) {
        // A failed poll keeps the events already read. Clearing them made a
        // passing network error read as a story with no history at all.
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [taskId]);

  const phase = loadPhase({ key: taskId, loadedFor, error });
  if (phase === 'loading') return <Loading label="Reading the timeline" rows={4} />;
  if (phase === 'failed') return <Empty>The timeline could not be read. {error}</Empty>;
  if (events.length === 0) return <Empty>No event has been recorded yet.</Empty>;

  // Tool calls are most of the volume and least of the meaning, so they are
  // hidden until asked for rather than drowning the transitions.
  const interesting = expanded ? events : events.filter((event) => event.eventType !== 'ToolCalled');

  return (
    <Card>
      <div className="row-between">
        <span className="meta">Timeline · {events.length} event(s)</span>
        <button className="filter" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide tool calls' : 'Show every tool call'}
        </button>
      </div>
      <div className="steps">
        {interesting
          .slice()
          .reverse()
          .map((event) => (
            <div className="step done" key={event.eventId} style={{ alignItems: 'baseline' }}>
              <span className="step-times" style={{ textAlign: 'left', minWidth: 96 }}>
                {formatStamp(event.createdAt)}
              </span>
              <Badge tone={ACTOR_TONES[event.actorType] ?? 'running'}>{event.actorId}</Badge>
              <div className="grow">
                <div className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                  {describe(event)}
                </div>
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}
