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
 * What an agent produced: findings, transcripts, reports, diffs, test output.
 *
 * All of it is text measured in kilobytes and all of it lives in Postgres, so a
 * project's history is one thing that can be read, backed up and deleted as one
 * thing.
 */
export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactRecord>;
  get(id: string): Promise<{ record: ArtifactRecord; content: Buffer }>;
  getText(id: string): Promise<string>;
  /**
   * Writes a copy somewhere an agent can be pointed at it, instead of carrying
   * the contents inline in every prompt, and returns its path. It is a copy: the
   * artifact itself is the row.
   */
  materialise(record: ArtifactRecord): Promise<string>;
  /** The directory those copies land in, for granting an agent access to it. */
  materialisedDirectory(projectId: string): string;
  stream(id: string): Promise<Readable>;
  delete(id: string): Promise<void>;
}
