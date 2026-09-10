'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

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

export default function KnowledgePage() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState('');
  const [term, setTerm] = useState('');

  async function load(selectedKind: string) {
    const query = selectedKind ? `?kind=${encodeURIComponent(selectedKind)}` : '';
    const result = await api.get<{ snapshots: Snapshot[]; entities: Entity[]; summary: string | null; total?: number }>(
      `/api/project-knowledge${query}`,
    );
    setSnapshots(result.snapshots);
    setEntities(result.entities);
    setSummary(result.summary);
    setTotal(result.total ?? result.entities.length);
  }

  useEffect(() => {
    void load(kind);
  }, [kind]);

  async function search() {
    if (!term) return void load(kind);
    const result = await api.get<{ entities: Entity[] }>(`/api/project-knowledge/search?q=${encodeURIComponent(term)}`);
    setEntities(result.entities);
    setTotal(result.entities.length);
  }

  return (
    <div>
      <h2>Project Knowledge</h2>
      <p className="subtitle">What the system understands about how this project is actually built.</p>

      <div className="card">
        <div className="row">
          <input type="text" value={term} placeholder="Search entities" onChange={(event) => setTerm(event.target.value)} className="grow" />
          <button onClick={() => void search()}>Search</button>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">All kinds</option>
            {['module', 'file', 'class', 'interface', 'type', 'function', 'endpoint', 'database_table'].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        {summary ? <pre>{summary}</pre> : null}
      </div>

      {snapshots.length > 0 ? (
        <p className="card-detail">
          Latest snapshot {snapshots[0]!.sequence} at commit {snapshots[0]!.gitCommit.slice(0, 10)} ({snapshots[0]!.status})
        </p>
      ) : null}

      <h3>
        Entities ({entities.length} of {total})
      </h3>
      {entities.length === 0 ? (
        <p className="empty">
          Nothing matches. Clear the search term or pick a different kind to see what the system has indexed.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="col-sm">Kind</th>
                <th className="col-lg">Name</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((entity) => (
                <tr key={entity.id}>
                  <td className="meta">{entity.kind}</td>
                  <td>{entity.name}</td>
                  <td className="meta">{entity.path ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
