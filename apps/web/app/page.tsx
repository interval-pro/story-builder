'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type Project, type Story } from '../lib/api';
import { relativeAge } from '../lib/relative-time';
import { RiskBadge, StateBadge } from '../components/state-badge';

export default function StoriesPage() {
  const [stories, setStories] = useState<Story[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = projects.find((project) => project.id === projectId) ?? null;

  useEffect(() => {
    async function loadProjects() {
      try {
        const result = await api.get<{ projects: Project[] }>('/api/projects');
        setProjects(result.projects);
        setProjectId((current) => current || result.projects.find((p) => p.kind === 'PROJECT')?.id || '');
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void loadProjects();
  }, []);

  useEffect(() => {
    if (!projectId) return undefined;
    async function load() {
      try {
        const result = await api.get<{ stories: Story[] }>(`/api/stories?projectId=${projectId}`);
        setStories(result.stories);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [projectId]);

  async function create() {
    setCreating(true);
    try {
      await api.post('/api/stories', { body, projectId });
      setBody('');
      const result = await api.get<{ stories: Story[] }>(`/api/stories?projectId=${projectId}`);
      setStories(result.stories);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h2>Stories</h2>
      <p className="subtitle">Describe what should change. The system researches, reviews and implements it.</p>

      <div className="toolbar">
        <label className="card-label">Target</label>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {project.kind === 'INSTALLATION' ? ' — the engine itself' : ''}
            </option>
          ))}
        </select>
      </div>
      {selected?.kind === 'INSTALLATION' ? (
        <p className="meta">
          This story changes the engine that runs your tasks, not your project. Nothing is pushed anywhere.
          When it finishes you apply it from the task page, which restarts the system.
        </p>
      ) : null}

      <div className="card">
        <textarea
          rows={5}
          value={body}
          placeholder={'When a user changes their email address, send a verification email and do not treat the new address as verified until the verification completes.'}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="actions">
          <button onClick={() => void create()} disabled={creating || !projectId || body.trim().length < 10}>
            {creating ? 'Creating...' : 'Create story'}
          </button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {stories.length === 0 ? (
        <p className="empty">No stories yet. Describe a change above and create the first one.</p>
      ) : (
        stories.map((story) => {
          const task = story.tasks[0];
          return (
            <div key={story.id} className="card">
              <div className="card-row">
                <div>
                  <div className="card-value">
                    {task ? <Link href={`/tasks/${task.id}`}>{story.title}</Link> : story.title}
                  </div>
                  <div className="card-detail">
                    revision {story.currentRevision} · {new Date(story.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="row">
                  {task ? <RiskBadge level={task.riskLevel} /> : null}
                  {task ? <StateBadge state={task.state} /> : <span className="badge waiting">No task</span>}
                  <span className="age">{relativeAge(story.createdAt)}</span>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
