import { createLogger, ValidationError } from '@ai-engine/shared';
import { createRepositories, Database, type Repositories } from '@ai-engine/db';
import { EventLog } from '@ai-engine/events';
import { JobQueue } from '@ai-engine/queue';
import { FilesystemArtifactStore } from '@ai-engine/artifacts';
import { ProjectBrain } from '@ai-engine/project-brain';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { ConflictEngine } from '@ai-engine/conflict-engine';
import { Orchestrator, TaskCommands, type Actor } from '@ai-engine/orchestrator';

export interface ApiContext {
  db: Database;
  repos: Repositories;
  events: EventLog;
  queue: JobQueue;
  artifacts: FilesystemArtifactStore;
  brain: ProjectBrain;
  knowledge: KnowledgeService;
  conflicts: ConflictEngine;
  orchestrator: Orchestrator;
  commands: TaskCommands;
  logger: ReturnType<typeof createLogger>;
}

export function createApiContext(db: Database): ApiContext {
  const orchestrator = new Orchestrator(db);
  return {
    db,
    repos: createRepositories(db),
    events: new EventLog(db),
    queue: new JobQueue(db),
    artifacts: new FilesystemArtifactStore(db),
    brain: new ProjectBrain(db),
    knowledge: new KnowledgeService(db),
    conflicts: new ConflictEngine(db),
    orchestrator,
    commands: new TaskCommands(db, orchestrator),
    logger: createLogger('api'),
  };
}

/**
 * v0 is single user. The actor still travels with every request so the event
 * log is honest about who did what once roles exist.
 */
export function actorFrom(headers: Record<string, unknown>): Actor {
  const raw = headers['x-ai-engine-user'];
  const id = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'human';
  return { type: 'human', id };
}

export function requireBody<T extends Record<string, unknown>>(body: unknown, fields: (keyof T)[]): T {
  if (typeof body !== 'object' || body === null) throw new ValidationError('A JSON body is required');
  const record = body as T;
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === null || value === '') {
      throw new ValidationError(`Field "${String(field)}" is required`);
    }
  }
  return record;
}

/** The single project this installation manages. */
export async function primaryProjectId(context: ApiContext, override?: string | null): Promise<string> {
  if (override) return override;
  const project = await context.repos.projects.findPrimary();
  if (!project) throw new ValidationError('No project has been initialised. Run "ai-engine init" first.');
  return project.id;
}
