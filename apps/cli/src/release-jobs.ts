/**
 * Hands back every running job, because the workers holding them are gone.
 *
 * Run by the stop script once the processes have been killed. Without it a
 * deliberate restart leaves the last job of each worker marked RUNNING with a
 * lease nobody is renewing, and since a running job holds its project's working
 * directory, the whole project stays locked until the lease times out — fifteen
 * minutes of a system that looks up and does nothing.
 *
 * Safe only because it is called after the processes are stopped. The lease is
 * the right rule when nobody knows whether a worker is alive; this is the case
 * where we do know.
 */
import { Database } from '@ai-engine/db';
import { JobQueue } from '@ai-engine/queue';

async function main(): Promise<void> {
  const db = new Database();
  try {
    const released = await new JobQueue(db).releaseAllRunning();
    if (released > 0) process.stdout.write(`handed back ${released} running job(s)\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  // A stop must not fail because the database was already down; that is the
  // normal order of things when the whole stack is being shut off.
  process.stderr.write(`could not hand back running jobs: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
});
