'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useProjects } from '../../components/shell';
import { Badge, Bar, Button, Card, Dialog, Empty, ErrorText, Field } from '../../components/ui';

interface Principle {
  id: string;
  category: string;
  statement: string;
  scope: string;
  status: string;
  strength: number;
  evidenceCount: number;
}

interface Invariant {
  id: string;
  statement: string;
  scope: string;
  status: string;
  confidence: number;
}

function strengthWord(strength: number): string {
  if (strength >= 0.75) return 'Strong';
  if (strength >= 0.5) return 'Settling';
  return 'New';
}

/**
 * Why, not what.
 *
 * Every statement here was learned from a correction someone made, and carries
 * the number of corrections behind it. That count is the whole value: a principle
 * with four corrections behind it is how this team works, and one with a single
 * correction is a hypothesis.
 */
export default function BrainPage() {
  const { project } = useProjects();
  const [principles, setPrinciples] = useState<Principle[]>([]);
  const [invariants, setInvariants] = useState<Invariant[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statementRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const result = await api.get<{ principles: Principle[]; invariants: Invariant[] }>(
        `/api/project-brain?projectId=${project.id}`,
      );
      setPrinciples(result.principles);
      setInvariants(result.invariants);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const statement = statementRef.current?.value.trim() ?? '';
    if (statement.length < 10) {
      setError('A principle needs a sentence.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/project-brain/principles?projectId=${project?.id}`, {
        statement,
        category: categoryRef.current?.value.trim() || 'general',
      });
      setAdding(false);
      await load();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  const active = principles.filter((principle) => principle.status === 'ACTIVE');

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Project Brain</h1>
          <p className="standfirst">
            Why, not what. Each statement was learned from a correction you made, and the number of corrections behind it
            is what says how much weight it carries.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setAdding(true)} disabled={!project}>
          Add a principle
        </Button>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      {active.length === 0 ? (
        <Empty>
          Nothing has been learned yet. Principles appear here when you correct a plan and the system works out the
          general rule behind your correction.
        </Empty>
      ) : (
        <div className="grid">
          {active.map((principle) => (
            <Card key={principle.id}>
              <div className="row-between">
                <span className="meta" style={{ color: 'var(--text-accent)' }}>
                  {principle.category.replace(/_/g, ' ')}
                </span>
                <span className="meta">
                  {principle.evidenceCount} correction{principle.evidenceCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="accent-rule" />
              <div className="body-sm" style={{ color: 'var(--ivory-100)', fontSize: 15.5, lineHeight: 1.6 }}>
                {principle.statement}
              </div>
              <div className="row" style={{ marginTop: 'auto' }}>
                <div className="grow">
                  <Bar
                    percent={principle.strength * 100}
                    tone={principle.strength >= 0.75 ? undefined : 'caution'}
                  />
                </div>
                <span className="meta">{strengthWord(principle.strength)}</span>
              </div>
              <span className="meta">{principle.scope}</span>
            </Card>
          ))}
        </div>
      )}

      <section className="stack">
        <div>
          <h2 className="subhead">Invariants</h2>
          <p className="standfirst">Things that must never be violated. The checks read these on every change.</p>
        </div>
        {invariants.length === 0 ? (
          <Empty>No invariant has been recorded.</Empty>
        ) : (
          <div className="list">
            {invariants.map((invariant) => (
              <div className="list-row accent-done" key={invariant.id}>
                <div className="grow">
                  <div className="list-title">{invariant.statement}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {invariant.scope}
                  </div>
                </div>
                <Badge tone={invariant.status === 'ACTIVE' ? 'done' : 'waiting'}>{invariant.status.toLowerCase()}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        eyebrow="Project Brain"
        title="Add a principle"
        footer={
          <>
            <Button onClick={() => void add()} disabled={busy}>
              Add it
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <p className="body-sm">
          A principle is a sentence about how work is done here, not a description of what the code currently does. The
          system already reads the code.
        </p>
        <Field label="The principle">
          <input
            ref={statementRef}
            placeholder="Prefer extending an existing responsibility over adding a component."
          />
        </Field>
        <Field label="Category">
          <input ref={categoryRef} placeholder="architecture" />
        </Field>
      </Dialog>
    </div>
  );
}
