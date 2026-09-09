import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A project records which installation serves it, so a command run from inside
 * the project can find the engine without being told where it lives.
 */
export interface InstallationMarker {
  /** Absolute path of the installation directory. */
  installRoot: string;
  /** Name the installation was registered under. */
  name: string;
  /** Release the installation was created from, when it came from one. */
  version: string | null;
  installedAt: string;
}

export const MARKER_RELATIVE_PATH = path.join('.ai-engineering', 'installation.json');

export function markerPath(projectRoot: string): string {
  return path.join(projectRoot, MARKER_RELATIVE_PATH);
}

export async function readInstallationMarker(projectRoot: string): Promise<InstallationMarker | null> {
  try {
    const raw = await readFile(markerPath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<InstallationMarker>;
    if (!parsed.installRoot) return null;
    return {
      installRoot: parsed.installRoot,
      name: parsed.name ?? path.basename(projectRoot),
      version: parsed.version ?? null,
      installedAt: parsed.installedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeInstallationMarker(projectRoot: string, marker: InstallationMarker): Promise<void> {
  const target = markerPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/**
 * Walks up from a directory until a marker turns up, so the command works from
 * anywhere inside the project rather than only at its root.
 */
export async function findInstallation(
  startDir: string,
): Promise<{ projectRoot: string; marker: InstallationMarker } | null> {
  let current = path.resolve(startDir);
  for (;;) {
    const marker = await readInstallationMarker(current);
    if (marker) return { projectRoot: current, marker };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
