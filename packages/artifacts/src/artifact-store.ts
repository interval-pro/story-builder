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
  stream(id: string): Promise<Readable>;
  delete(id: string): Promise<void>;
}
