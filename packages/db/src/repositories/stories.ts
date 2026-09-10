import { newId, NotFoundError } from '@ai-engine/shared';
import type { Story, StoryRevision } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const STORY_COLUMNS = 'id, project_id, title, current_revision, created_at, updated_at';
const REVISION_COLUMNS = 'id, story_id, revision, body, created_by, created_at';

export interface StoryWithRevision extends Story {
  latestRevision: StoryRevision;
}

export class StoryRepository {
  constructor(private readonly db: Queryable) {}

  /** Creates the story together with its first immutable revision. */
  async create(input: {
    projectId: string;
    title: string;
    body: string;
    createdBy?: string;
  }): Promise<{ story: Story; revision: StoryRevision }> {
    const storyRow = await this.db.queryOne(
      `INSERT INTO stories (id, project_id, title, current_revision)
       VALUES ($1, $2, $3, 1) RETURNING ${STORY_COLUMNS}`,
      [newId(), input.projectId, input.title],
    );
    const story = camelize<Story>(storyRow!);
    const revisionRow = await this.db.queryOne(
      `INSERT INTO story_revisions (id, story_id, revision, body, created_by)
       VALUES ($1, $2, 1, $3, $4) RETURNING ${REVISION_COLUMNS}`,
      [newId(), story.id, input.body, input.createdBy ?? 'human'],
    );
    return { story, revision: camelize<StoryRevision>(revisionRow!) };
  }

  /** Story text is never edited in place; a new revision is appended instead. */
  async addRevision(storyId: string, body: string, createdBy = 'human'): Promise<StoryRevision> {
    const storyRow = await this.db.queryOne(
      `UPDATE stories SET current_revision = current_revision + 1, updated_at = now()
       WHERE id = $1 RETURNING ${STORY_COLUMNS}`,
      [storyId],
    );
    if (!storyRow) throw new NotFoundError('Story', storyId);
    const story = camelize<Story>(storyRow);
    const revisionRow = await this.db.queryOne(
      `INSERT INTO story_revisions (id, story_id, revision, body, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${REVISION_COLUMNS}`,
      [newId(), storyId, story.currentRevision, body, createdBy],
    );
    return camelize<StoryRevision>(revisionRow!);
  }

  async findById(id: string): Promise<Story | null> {
    const row = await this.db.queryOne(`SELECT ${STORY_COLUMNS} FROM stories WHERE id = $1`, [id]);
    return row ? camelize<Story>(row) : null;
  }

  async getById(id: string): Promise<Story> {
    const story = await this.findById(id);
    if (!story) throw new NotFoundError('Story', id);
    return story;
  }

  async listByProject(projectId: string, limit = 100): Promise<Story[]> {
    return camelizeAll<Story>(
      await this.db.query(`SELECT ${STORY_COLUMNS} FROM stories WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`, [
        projectId,
        limit,
      ]),
    );
  }

  async listRevisions(storyId: string): Promise<StoryRevision[]> {
    return camelizeAll<StoryRevision>(
      await this.db.query(`SELECT ${REVISION_COLUMNS} FROM story_revisions WHERE story_id = $1 ORDER BY revision ASC`, [
        storyId,
      ]),
    );
  }

  async getRevision(id: string): Promise<StoryRevision> {
    const row = await this.db.queryOne(`SELECT ${REVISION_COLUMNS} FROM story_revisions WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('StoryRevision', id);
    return camelize<StoryRevision>(row);
  }

  async getLatestRevision(storyId: string): Promise<StoryRevision> {
    const row = await this.db.queryOne(
      `SELECT ${REVISION_COLUMNS} FROM story_revisions WHERE story_id = $1 ORDER BY revision DESC LIMIT 1`,
      [storyId],
    );
    if (!row) throw new NotFoundError('StoryRevision for story', storyId);
    return camelize<StoryRevision>(row);
  }
}
