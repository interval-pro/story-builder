'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type Story } from '../lib/api';
import { RiskBadge, StateBadge } from '../components/state-badge';

export default function StoriesPage() {
  const [stories, setStories] = useState<Story[]>([]);
  const [body, setBody] = useState('');
  const [systemStory, setSystemStory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const result = await api.get<{ stories: Story[] }>('/api/stories');
      setStories(result.stories);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  async function create() {
    setCreating(true);
    try {
      await api.post('/api/stories', { body, kind: systemStory ? 'SYSTEM_TASK' : 'PROJECT_TASK' });
      setBody('');
      await load();
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

      <div className="card">
        <textarea
          rows={5}
          value={body}
          placeholder={'When a user changes their email address, send a verification email and do not treat the new address as verified until the verification completes.'}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => void create()} disabled={creating || body.trim().length < 10}>
            {creating ? 'Creating...' : 'Create story'}
          </button>
          <label className="meta">
            <input
              type="checkbox"
              checked={systemStory}
              onChange={(event) => setSystemStory(event.target.checked)}
              style={{ marginRight: 6 }}
            />
            System story (may change the AI engineering system itself)
          </label>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {stories.length === 0 ? (
        <p className="empty">No stories yet.</p>
      ) : (
        stories.map((story) => {
          const task = story.tasks[0];
          return (
            <div key={story.id} className="card">
              <div className="card-row">
                <div>
                  <strong>
                    {task ? <Link href={`/tasks/${task.id}`}>{story.title}</Link> : story.title}
                  </strong>
                  <div className="meta">
                    revision {story.currentRevision} · {new Date(story.createdAt).toLocaleString()}
                    {story.kind === 'SYSTEM_TASK' ? ' · system story' : ''}
                  </div>
                </div>
                <div className="row">
                  {task ? <RiskBadge level={task.riskLevel} /> : null}
                  {task ? <StateBadge state={task.state} /> : <span className="badge waiting">No task</span>}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
