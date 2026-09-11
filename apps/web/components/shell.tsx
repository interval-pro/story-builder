'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, type Project, type QueueView } from '../lib/api';

/**
 * Which project the cockpit is looking at.
 *
 * An installation serves several repositories now, so almost every screen is
 * about one of them. The choice lives here rather than in each page, and it is
 * remembered between visits: picking the same project again on every page load is
 * the kind of friction that makes a person keep one tab open forever.
 *
 * The queue is the exception. It is deliberately global, because the whole point
 * of one shared queue is seeing whose work is waiting behind whose.
 */
interface ProjectState {
  projects: Project[];
  project: Project | null;
  installation: Project | null;
  select: (id: string) => void;
  reload: () => Promise<void>;
  queue: QueueView | null;
  loading: boolean;
  error: string | null;
}

const Context = createContext<ProjectState>({
  projects: [],
  project: null,
  installation: null,
  select: () => undefined,
  reload: async () => undefined,
  queue: null,
  loading: true,
  error: null,
});

export function useProjects(): ProjectState {
  return useContext(Context);
}

const STORAGE_KEY = 'story-builder.project';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/stories', label: 'Stories' },
  { href: '/queue', label: 'Queue' },
  { href: '/chat', label: 'Chat' },
  { href: '/brain', label: 'Brain' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/projects', label: 'Projects' },
  { href: '/settings', label: 'Settings' },
  { href: '/system', label: 'System' },
];

function crumbFor(pathname: string, project: Project | null): string {
  const base = project ? project.name.toUpperCase() : 'STORY BUILDER';
  if (pathname === '/') return `${base} · OVERVIEW`;
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  if (first === 'tasks') return `${base} · STORIES · ${(segments[1] ?? '').slice(0, 8).toUpperCase()}`;
  if (first === 'ideas') return `${base} · DESCRIBE AN IDEA`;
  if (first === 'queue') return 'EVERY PROJECT · QUEUE';
  if (first === 'system' || first === 'settings' || first === 'projects') return first.toUpperCase();
  return `${base} · ${first.toUpperCase()}`;
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await api.get<{ projects: Project[] }>('/api/projects');
      setProjects(result.projects);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The counts in the sidebar are the reason this poll is here: a number that
  // only updates when you navigate is worse than no number.
  useEffect(() => {
    async function load() {
      try {
        setQueue(await api.get<QueueView>('/api/queue'));
      } catch {
        setQueue(null);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setSelected(stored);
  }, []);

  const workProjects = useMemo(() => projects.filter((project) => project.kind === 'PROJECT'), [projects]);
  const installation = useMemo(() => projects.find((project) => project.kind === 'INSTALLATION') ?? null, [projects]);

  // A remembered project that has since been removed must not leave the cockpit
  // pointing at nothing, so the choice falls back to the first one that exists.
  const project = useMemo(
    () => workProjects.find((candidate) => candidate.id === selected) ?? workProjects[0] ?? installation ?? null,
    [workProjects, selected, installation],
  );

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, id);
    },
    [],
  );

  const value: ProjectState = { projects, project, installation, select, reload, queue, loading, error };

  const waiting = queue?.waiting.length ?? 0;
  const running = queue?.running ?? 0;
  const pending = queue?.pending ?? 0;

  return (
    <Context.Provider value={value}>
      <div className="shell">
        <aside className="sidebar">
          <div>
            <div className="sidebar-brand">Story Builder</div>
            <div className="sidebar-version">Cockpit</div>
          </div>

          <div className="col">
            <span className="meta">Project</span>
            <select
              className="switcher"
              value={project?.id ?? ''}
              onChange={(event) => select(event.target.value)}
              aria-label="Project"
            >
              {projects.length === 0 ? <option value="">No project yet</option> : null}
              {workProjects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.setupState !== 'READY' ? ` — ${candidate.setupState.toLowerCase()}` : ''}
                </option>
              ))}
              {installation ? (
                <option value={installation.id}>{installation.name} — the engine itself</option>
              ) : null}
            </select>
            {project?.kind === 'INSTALLATION' ? (
              <span className="body-sm">
                Stories here change the engine, not a project of yours. Nothing is pushed anywhere.
              </span>
            ) : null}
          </div>

          <nav className="nav">
            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const count =
                item.href === '/queue' ? pending + running : item.href === '/' && waiting > 0 ? waiting : 0;
              return (
                <Link key={item.href} href={item.href} className={`nav-item ${active ? 'active' : ''}`}>
                  <span>{item.label}</span>
                  {count > 0 ? (
                    <span className={`nav-count ${item.href === '/' ? 'attention' : ''}`}>{count}</span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="col" style={{ borderTop: '1px solid var(--line-hairline)', paddingTop: 18 }}>
            <span className="meta">Runtime</span>
            <div className="row" style={{ gap: 10 }}>
              <span style={{ width: 22, height: 2, background: 'var(--status-positive)' }} />
              <span className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                {running} running of {queue?.policy.concurrency ?? 1}
              </span>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <span style={{ width: 22, height: 2, background: 'var(--ochre-500)' }} />
              <span className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                {pending} in the queue
              </span>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <span style={{ width: 22, height: 2, background: 'var(--orange-550)' }} />
              <span className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                {waiting} waiting for you
              </span>
            </div>
            {queue?.policy.paused ? (
              <span className="badge waiting" style={{ marginTop: 8 }}>
                Queue paused
              </span>
            ) : null}
          </div>

          <div
            className="meta"
            style={{ marginTop: 'auto', borderTop: '1px solid var(--line-hairline)', paddingTop: 16, lineHeight: 1.7 }}
          >
            Nothing is written until
            <br />
            you approve a plan
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div className="crumb">{crumbFor(pathname, project)}</div>
            <button className="btn" onClick={() => router.push('/stories?compose=1')} disabled={!project}>
              Describe an idea
            </button>
          </header>
          {children}
        </main>
      </div>
    </Context.Provider>
  );
}
