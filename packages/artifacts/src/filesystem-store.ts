import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { loadConfig, newId, NotFoundError } from '@ai-engine/shared';
import type { ArtifactRecord } from '@ai-engine/domain';
import { ArtifactRepository, type Queryable } from '@ai-engine/db';
import type { ArtifactStore, PutArtifactInput } from './artifact-store';

const EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/x-diff': 'diff',
  'image/png': 'png',
};

/**
 * v0 implementation backed by a Docker persistent volume. The interface is kept
 * narrow so S3 or MinIO can replace it later without touching call sites.
 */
export class FilesystemArtifactStore implements ArtifactStore {
  private readonly repository: ArtifactRepository;
  private readonly root: string;

  constructor(db: Queryable, root?: string) {
    this.repository = new ArtifactRepository(db);
    this.root = root ?? loadConfig().paths.artifactsRoot;
  }

  private resolve(storagePath: string): string {
    const absolute = path.resolve(this.root, storagePath);
    if (!absolute.startsWith(path.resolve(this.root))) {
      throw new Error(`Artifact path escapes the store root: ${storagePath}`);
    }
    return absolute;
  }

  async put(input: PutArtifactInput): Promise<ArtifactRecord> {
    const id = newId();
    const contentType = input.contentType ?? 'text/plain';
    const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const extension = EXTENSIONS[contentType] ?? 'bin';
    const scope = input.taskId ?? 'project';
    const storagePath = path.join(input.projectId, scope, input.kind, `${id}.${extension}`);
    const absolute = this.resolve(storagePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);
    return this.repository.create({
      id,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      contentType,
      sizeBytes: buffer.byteLength,
      storagePath,
      checksum,
      metadata: input.metadata ?? {},
    });
  }

  async get(id: string): Promise<{ record: ArtifactRecord; content: Buffer }> {
    const record = await this.repository.getById(id);
    try {
      return { record, content: await readFile(this.resolve(record.storagePath)) };
    } catch (error) {
      // The row outlives the file when the store is moved or cleared, and a
      // caller can only recover from that if it is told the artifact is gone.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError('Artifact', id);
      }
      throw error;
    }
  }

  async getText(id: string): Promise<string> {
    const { content } = await this.get(id);
    return content.toString('utf8');
  }

  async stream(id: string): Promise<Readable> {
    const record = await this.repository.getById(id);
    return createReadStream(this.resolve(record.storagePath));
  }

  async delete(id: string): Promise<void> {
    const record = await this.repository.getById(id);
    await rm(this.resolve(record.storagePath), { force: true });
    await this.repository.delete(id);
  }
}
