import { newId, NotFoundError } from '@ai-engine/shared';
import type { Project, ProjectKind } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const COLUMNS = 'id, name, repo_path, default_branch, remote_url, kind, created_at, updated_at';

export class ProjectRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    name: string;
    repoPath: string;
    defaultBranch?: string;
    remoteUrl?: string | null;
    kind?: ProjectKind;
  }): Promise<Project> {
    const row = await this.db.queryOne(
      `INSERT INTO projects (id, name, repo_path, default_branch, remote_url, kind)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [
        newId(),
        input.name,
        input.repoPath,
        input.defaultBranch ?? 'main',
        input.remoteUrl ?? null,
        input.kind ?? 'PROJECT',
      ],
    );
    return camelize<Project>(row!);
  }

  async list(): Promise<Project[]> {
    return camelizeAll<Project>(await this.db.query(`SELECT ${COLUMNS} FROM projects ORDER BY created_at ASC`));
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

  async update(id: string, patch: Partial<Pick<Project, 'name' | 'defaultBranch' | 'remoteUrl'>>): Promise<Project> {
    const row = await this.db.queryOne(
      `UPDATE projects SET
         name = COALESCE($2, name),
         default_branch = COALESCE($3, default_branch),
         remote_url = COALESCE($4, remote_url),
         updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, patch.name ?? null, patch.defaultBranch ?? null, patch.remoteUrl ?? null],
    );
    if (!row) throw new NotFoundError('Project', id);
    return camelize<Project>(row);
  }
}
