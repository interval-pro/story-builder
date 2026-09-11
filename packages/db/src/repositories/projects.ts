import { newId, NotFoundError } from '@ai-engine/shared';
import type { Project, ProjectKind } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const COLUMNS = `id, name, repo_path, default_branch, remote_url, kind, description, setup_state,
  setup_error, work_branch, remote_access, remote_checked_at, merge_conflict_task_id, archived_at,
  created_at, updated_at`;

export class ProjectRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    name: string;
    repoPath: string;
    defaultBranch?: string;
    remoteUrl?: string | null;
    kind?: ProjectKind;
    description?: string | null;
    /**
     * A project added from the cockpit is not usable until it has been read once,
     * so it starts PENDING and a setup job moves it on. The installation registers
     * itself as READY, because it was prepared before this row existed.
     */
    setupState?: Project['setupState'];
    /** The branch stories start from. Defaults to the repository's own default. */
    workBranch?: string;
  }): Promise<Project> {
    const row = await this.db.queryOne(
      `INSERT INTO projects (id, name, repo_path, default_branch, remote_url, kind, description, setup_state, work_branch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [
        newId(),
        input.name,
        input.repoPath,
        input.defaultBranch ?? 'main',
        input.remoteUrl ?? null,
        input.kind ?? 'PROJECT',
        input.description ?? null,
        input.setupState ?? 'READY',
        input.workBranch ?? input.defaultBranch ?? 'main',
      ],
    );
    return camelize<Project>(row!);
  }

  async list(): Promise<Project[]> {
    return camelizeAll<Project>(
      await this.db.query(`SELECT ${COLUMNS} FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC`),
    );
  }

  /** The repositories the system works on, without the installation itself. */
  async listWorkProjects(): Promise<Project[]> {
    return camelizeAll<Project>(
      await this.db.query(
        `SELECT ${COLUMNS} FROM projects WHERE kind = 'PROJECT' AND archived_at IS NULL ORDER BY created_at ASC`,
      ),
    );
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [id]);
    return row ? camelize<Project>(row) : null;
  }

  async getById(id: string): Promise<Project> {
    const project = await this.findById(id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  }

  async findByRepoPath(repoPath: string): Promise<Project | null> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM projects WHERE repo_path = $1`, [repoPath]);
    return row ? camelize<Project>(row) : null;
  }

  /**
   * The repository this installation works on. The installation itself is also
   * a project, so the primary one is the first that is not an installation.
   */
  async findPrimary(): Promise<Project | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM projects WHERE kind = 'PROJECT' ORDER BY created_at ASC LIMIT 1`,
    );
    return row ? camelize<Project>(row) : null;
  }

  async findInstallation(): Promise<Project | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM projects WHERE kind = 'INSTALLATION' ORDER BY created_at ASC LIMIT 1`,
    );
    return row ? camelize<Project>(row) : null;
  }

  /** Records how the setup job went, so the cockpit can say more than "broken". */
  async setSetupState(id: string, state: Project['setupState'], error: string | null = null): Promise<Project> {
    const row = await this.db.queryOne(
      `UPDATE projects SET setup_state = $2, setup_error = $3, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, state, error],
    );
    if (!row) throw new NotFoundError('Project', id);
    return camelize<Project>(row);
  }

  /**
   * Removes a project and everything that hangs off it.
   *
   * Every table that references a project cascades, so one statement takes its
   * stories, tasks, runs, artifact rows, knowledge and chats with it. The files
   * those artifact rows point at are removed by the caller, which is the only
   * part of a project that lives outside the database.
   *
   * The cascade reaches the event log, which is append-only and refuses a delete
   * unless this transaction asks for it. The permission is set with SET LOCAL, so
   * it lasts exactly as long as this transaction and cannot leak into anything
   * else the connection goes on to do.
   */
  async remove(id: string): Promise<void> {
    const db = this.db as Queryable & {
      transaction?: <T>(callback: (tx: Queryable) => Promise<T>) => Promise<T>;
    };
    if (!db.transaction) {
      throw new Error('Removing a project needs a transaction, so the repository must be built on the database');
    }
    await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ai_engine.allow_event_deletion = 'on'`);
      await tx.query('DELETE FROM projects WHERE id = $1', [id]);
    });
  }

  /**
   * Records whether a push and a pull request are actually possible.
   *
   * Established when the project is added rather than discovered by a push that
   * fails at the very end of a story, which is what happened before.
   */
  async setRemoteAccess(id: string, access: Project['remoteAccess']): Promise<Project> {
    const row = await this.db.queryOne(
      `UPDATE projects SET remote_access = $2, remote_checked_at = now(), updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, access],
    );
    if (!row) throw new NotFoundError('Project', id);
    return camelize<Project>(row);
  }

  /**
   * Marks the project's directory as holding an unfinished merge, or free again.
   *
   * This is a lock, not a label: while it is set the queue starts nothing in this
   * project, because the conflict is sitting in the working tree waiting for
   * someone to open it in their editor.
   */
  async setMergeConflict(id: string, taskId: string | null): Promise<Project> {
    const row = await this.db.queryOne(
      `UPDATE projects SET merge_conflict_task_id = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, taskId],
    );
    if (!row) throw new NotFoundError('Project', id);
    return camelize<Project>(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'defaultBranch' | 'remoteUrl' | 'description' | 'workBranch'>>,
  ): Promise<Project> {
    const row = await this.db.queryOne(
      `UPDATE projects SET
         name = COALESCE($2, name),
         default_branch = COALESCE($3, default_branch),
         remote_url = COALESCE($4, remote_url),
         description = COALESCE($5, description),
         work_branch = COALESCE($6, work_branch),
         updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        id,
        patch.name ?? null,
        patch.defaultBranch ?? null,
        patch.remoteUrl ?? null,
        patch.description ?? null,
        patch.workBranch ?? null,
      ],
    );
    if (!row) throw new NotFoundError('Project', id);
    return camelize<Project>(row);
  }
}
