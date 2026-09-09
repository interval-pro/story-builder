import type { RuntimeManifestDocument } from '@ai-engine/domain';

export interface ManifestCommandRunner {
  run(input: { command: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ManifestValidationResult {
  valid: boolean;
  log: string;
  results: { phase: string; command: string; exitCode: number }[];
}

/**
 * A manifest is only trusted after its commands actually ran in a sandbox.
 * Detection alone is a guess.
 */
export async function validateRuntimeManifest(
  manifest: RuntimeManifestDocument,
  runner: ManifestCommandRunner,
  options: { runSetup?: boolean; runBuild?: boolean; runTests?: boolean; timeoutMs?: number } = {},
): Promise<ManifestValidationResult> {
  const timeoutMs = options.timeoutMs ?? 900_000;
  const results: { phase: string; command: string; exitCode: number }[] = [];
  const log: string[] = [];

  const phases: { phase: string; commands: string[]; enabled: boolean }[] = [
    { phase: 'setup', commands: manifest.setup.commands, enabled: options.runSetup ?? true },
    { phase: 'build', commands: manifest.build.commands, enabled: options.runBuild ?? true },
    { phase: 'test', commands: manifest.test.commands, enabled: options.runTests ?? true },
  ];

  for (const entry of phases) {
    if (!entry.enabled) continue;
    for (const command of entry.commands) {
      const outcome = await runner.run({ command, timeoutMs });
      results.push({ phase: entry.phase, command, exitCode: outcome.exitCode });
      log.push(
        `--- ${entry.phase}: ${command} (exit ${outcome.exitCode}) ---\n${outcome.stdout.slice(-4000)}\n${outcome.stderr.slice(-4000)}`,
      );
      if (outcome.exitCode !== 0) {
        return { valid: false, log: log.join('\n\n'), results };
      }
    }
  }

  return { valid: true, log: log.join('\n\n'), results };
}

/** A manifest with no test command cannot support the QA loop. */
export function manifestGaps(manifest: RuntimeManifestDocument): string[] {
  const gaps: string[] = [];
  if (manifest.project.language.length === 0) gaps.push('No language could be detected for this project.');
  if (manifest.setup.commands.length === 0) gaps.push('No setup command was detected.');
  if (manifest.test.commands.length === 0) gaps.push('No test command was detected, so QA cannot verify behaviour automatically.');
  if (manifest.build.commands.length === 0) gaps.push('No build command was detected.');
  return gaps;
}
