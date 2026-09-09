'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

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

export default function BrainPage() {
  const [principles, setPrinciples] = useState<Principle[]>([]);
  const [invariants, setInvariants] = useState<Invariant[]>([]);
  const [statement, setStatement] = useState('');
  const [category, setCategory] = useState('architecture');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const result = await api.get<{ principles: Principle[]; invariants: Invariant[] }>('/api/project-brain');
      setPrinciples(result.principles);
      setInvariants(result.invariants);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function addPrinciple() {
    await api.post('/api/project-brain/principles', { category, statement });
    setStatement('');
    await load();
  }

  async function retire(id: string) {
    await api.put(`/api/project-brain/principles/${id}`, { status: 'REJECTED' });
    await load();
  }

  const active = principles.filter((principle) => principle.status === 'ACTIVE');

  return (
    <div>
      <h2>Project Brain</h2>
      <p className="subtitle">How this team makes engineering decisions, learned from your corrections.</p>
      {error ? <p className="error">{error}</p> : null}

      <div className="card">
        <div className="row">
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          >
            {['architecture', 'code_style', 'testing', 'data_access', 'error_handling', 'security', 'performance', 'api_design', 'dependencies', 'deployment', 'domain_design', 'general'].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={statement}
            placeholder="Prefer extending an existing domain responsibility over introducing another component."
            onChange={(event) => setStatement(event.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={() => void addPrinciple()} disabled={statement.trim().length < 10}>
            Add
          </button>
        </div>
      </div>

      <h3>Principles ({active.length})</h3>
      {active.length === 0 ? (
        <p className="empty">Nothing learned yet. Principles appear as you correct reviews.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Category</th>
              <th>Statement</th>
              <th style={{ width: 110 }}>Evidence</th>
              <th style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {active.map((principle) => (
              <tr key={principle.id}>
                <td>{principle.category}</td>
                <td>{principle.statement}</td>
                <td className="meta">
                  {principle.evidenceCount}x · strength {principle.strength.toFixed(2)}
                </td>
                <td>
                  <button className="secondary" onClick={() => void retire(principle.id)}>
                    Retire
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Invariants ({invariants.length})</h3>
      {invariants.length === 0 ? (
        <p className="empty">No invariants have been extracted yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Statement</th>
              <th style={{ width: 120 }}>Scope</th>
              <th style={{ width: 120 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {invariants.map((invariant) => (
              <tr key={invariant.id}>
                <td>{invariant.statement}</td>
                <td className="meta">{invariant.scope}</td>
                <td>
                  <span className={`badge ${invariant.status === 'ACTIVE' ? 'done' : 'waiting'}`}>{invariant.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
