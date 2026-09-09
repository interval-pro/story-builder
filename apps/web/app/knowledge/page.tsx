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
          <input type="text" value={term} placeholder="Search entities" onChange={(event) => setTerm(event.target.value)} style={{ flex: 1 }} />
          <button onClick={() => void search()}>Search</button>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          >
            <option value="">All kinds</option>
            {['module', 'file', 'class', 'interface', 'type', 'function', 'endpoint', 'database_table'].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        {summary ? <pre style={{ marginTop: 12 }}>{summary}</pre> : null}
      </div>

      {snapshots.length > 0 ? (
        <div className="meta" style={{ marginBottom: 12 }}>
          Latest snapshot {snapshots[0]!.sequence} at commit {snapshots[0]!.gitCommit.slice(0, 10)} ({snapshots[0]!.status})
        </div>
      ) : null}

      <h3>
        Entities ({entities.length} of {total})
      </h3>
      <table>
        <thead>
          <tr>
            <th style={{ width: 140 }}>Kind</th>
            <th style={{ width: 260 }}>Name</th>
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
  );
}
