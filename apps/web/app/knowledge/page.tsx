'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useProjects } from '../../components/shell';
import { Button, Card, Empty, ErrorText, Tile } from '../../components/ui';
import { relativeAge } from '../../lib/format';

interface Entity {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  signature: string | null;
}

interface Snapshot {
  id: string;
  sequence: number;
  gitCommit: string;
  status: string;
  createdAt: string;
}

const KINDS = ['', 'module', 'file', 'function', 'class', 'type', 'route', 'table'];

/**
 * What the project is made of, as the system sees it.
 *
 * This is re-derived when the repository moves under it rather than maintained by
 * hand, so a stale snapshot is a fact about when it was last read rather than
 * something to correct.
 */
export default function KnowledgePage() {
  const { project } = useProjects();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState('');
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (selectedKind: string) => {
      if (!project) return;
      try {
        const query = new URLSearchParams({ projectId: project.id });
        if (selectedKind) query.set('kind', selectedKind);
        const result = await api.get<{
          snapshots: Snapshot[];
          entities: Entity[];
          summary: string | null;
          total?: number;
        }>(`/api/project-knowledge?${query.toString()}`);
        setSnapshots(result.snapshots);
        setEntities(result.entities);
        setSummary(result.summary);
        setTotal(result.total ?? result.entities.length);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [project],
  );

  useEffect(() => {
    void load(kind);
  }, [load, kind]);

  async function search() {
    if (!project || !term.trim()) {
      await load(kind);
      return;
    }
    const result = await api.get<{ entities: Entity[] }>(
      `/api/project-knowledge/search?projectId=${project.id}&q=${encodeURIComponent(term.trim())}`,
    );
    setEntities(result.entities);
    setTotal(result.entities.length);
  }

  async function refresh() {
    if (!project) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/knowledge-refresh`);
    } finally {
      setBusy(false);
    }
  }

  const latest = snapshots[0];

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Project Knowledge</h1>
          <p className="standfirst">
            What this project is made of and how it builds, read from the repository rather than written down. A story
            gets a stable picture of it, taken at the commit the story started from.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={busy || !project}>
          Read it again
        </Button>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <div className="tiles">
        <Tile value={total} label="Things found" />
        <Tile value={snapshots.length} label="Snapshots" />
        <Tile value={latest ? `#${latest.sequence}` : '—'} label="Latest snapshot" />
        <Tile value={latest ? relativeAge(latest.createdAt) : '—'} label="Last read" />
      </div>

      {summary ? (
        <Card>
          <span className="meta">How the system summarises this project</span>
          <div className="prose">{summary}</div>
        </Card>
      ) : null}

      <div className="row-between">
        <div className="filters">
          {KINDS.map((entry) => (
            <button key={entry || 'all'} className={`filter ${kind === entry ? 'active' : ''}`} onClick={() => setKind(entry)}>
              {entry || 'Everything'}
            </button>
          ))}
        </div>
        <div className="row">
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void search();
            }}
            placeholder="Search by name"
            style={{
              padding: '10px 14px',
              background: 'rgba(242,229,200,0.04)',
              border: '1px solid var(--line-hairline)',
              borderRadius: 'var(--radius-control)',
            }}
          />
          <Button size="sm" variant="secondary" onClick={() => void search()}>
            Search
          </Button>
        </div>
      </div>

      {entities.length === 0 ? (
        <Empty>Nothing matches. A project that has just been added may not have been read yet.</Empty>
      ) : (
        <Card>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {entities.slice(0, 300).map((entity) => (
                  <tr key={entity.id}>
                    <td>
                      {entity.name}
                      {entity.signature ? <div className="mono">{entity.signature.slice(0, 160)}</div> : null}
                    </td>
                    <td>{entity.kind}</td>
                    <td className="mono">{entity.path ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {entities.length > 300 ? <span className="meta">Showing the first 300 of {entities.length}.</span> : null}
        </Card>
      )}
    </div>
  );
}
