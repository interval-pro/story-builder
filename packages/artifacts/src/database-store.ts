import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig, statePaths } from '@ai-engine/shared';
import type { ArtifactRecord } from '@ai-engine/domain';
import { ArtifactRepository, type Queryable } from '@ai-engine/db';
import type { ArtifactStore, PutArtifactInput } from './artifact-store';

const EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/x-diff': 'diff',
};

/**
 * Artifacts live in Postgres.
 *
 * They were a row and a file, and the two could disagree: deleting a project took
 * the rows and left the files behind, and the only thing holding them together
 * was code that remembered to remove both. What they contain is text measured in
 * kilobytes — findings, transcripts, reports, diffs, test output — which Postgres
 * holds without effort.
 *
 * The one case that still needs a path is handing an agent a file to read instead
 * of carrying its contents inline in every prompt. That file is written on
 * demand, outside any repository, and is a copy rather than the original.
 */
export class DatabaseArtifactStore implements ArtifactStore {
  private readonly repository: ArtifactRepository;

  constructor(db: Queryable) {
    this.repository = new ArtifactRepository(db);
  }

  async put(input: PutArtifactInput): Promise<ArtifactRecord> {
    const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
    return this.repository.create({
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      contentType: input.contentType ?? 'text/plain',
      sizeBytes: buffer.byteLength,
      checksum: createHash('sha256').update(buffer).digest('hex'),
      content: buffer,
      metadata: input.metadata ?? {},
    });
  }

  async get(id: string): Promise<{ record: ArtifactRecord; content: Buffer }> {
    const record = await this.repository.getById(id);
    return { record, content: await this.repository.readContent(id) };
  }

  async getText(id: string): Promise<string> {
    return (await this.repository.readContent(id)).toString('utf8');
  }

  /**
   * Writes a copy where an agent can be pointed at it.
   *
   * It goes under the installation's own directory rather than into the project,
   * because nothing of ours belongs in a repository someone else owns, and the
   * agent reaches it through an explicitly granted directory. The name carries the
   * artifact id, so two runs never collide and the file says what it is.
   */
  async materialise(record: ArtifactRecord): Promise<string> {
    const directory = path.join(statePaths(loadConfig().paths.stateRoot).tmpDir, record.projectId);
    await mkdir(directory, { recursive: true });
    const extension = EXTENSIONS[record.contentType] ?? 'txt';
    const file = path.join(directory, `${record.kind}-${record.id.slice(0, 8)}.${extension}`);
    await writeFile(file, await this.repository.readContent(record.id));
    return file;
  }

  /** The directory a materialised file lands in, for granting access to it. */
  materialisedDirectory(projectId: string): string {
    return path.join(statePaths(loadConfig().paths.stateRoot).tmpDir, projectId);
  }

  async stream(id: string): Promise<Readable> {
    return Readable.from(await this.repository.readContent(id));
  }

  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }
}
