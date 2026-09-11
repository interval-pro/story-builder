import type { Readable } from 'node:stream';
import type { ArtifactRecord } from '@ai-engine/domain';

export interface PutArtifactInput {
  projectId: string;
  taskId?: string | null;
  runId?: string | null;
  kind: string;
  contentType?: string;
  content: string | Buffer;
  metadata?: Record<string, unknown>;
}

/**
 * Large execution output never goes into Postgres. Postgres keeps the metadata
 * row, the bytes live in the artifact store volume.
 */
export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactRecord>;
  get(id: string): Promise<{ record: ArtifactRecord; content: Buffer }>;
  getText(id: string): Promise<string>;
  /**
   * Absolute path of the stored bytes, for handing an agent something to read
   * instead of sending it inline on every run. A remote store would have to
   * materialise a local copy.
   */
  localPath(record: ArtifactRecord): string;
  stream(id: string): Promise<Readable>;
  delete(id: string): Promise<void>;
}
