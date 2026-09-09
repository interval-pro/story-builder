import type { RuntimeManifestDocument } from '@ai-engine/domain';

function yamlList(items: string[], indent: string): string {
  if (items.length === 0) return `${indent}[]`;
  return items.map((item) => `${indent}- ${JSON.stringify(item)}`).join('\n');
}

/** Writes the manifest as YAML for `.ai-engineering/runtime-manifest.yaml`. */
export function toYaml(manifest: RuntimeManifestDocument): string {
  const lines: string[] = [];
  lines.push('project:');
  lines.push('  language:');
  lines.push(yamlList(manifest.project.language, '    '));
  if (manifest.project.packageManager) lines.push(`  packageManager: ${manifest.project.packageManager}`);
  lines.push('');
  lines.push('setup:');
  lines.push('  commands:');
  lines.push(yamlList(manifest.setup.commands, '    '));
  lines.push('');
  lines.push('build:');
  lines.push('  commands:');
  lines.push(yamlList(manifest.build.commands, '    '));
  lines.push('');
  lines.push('test:');
  lines.push('  commands:');
  lines.push(yamlList(manifest.test.commands, '    '));
  lines.push('');
  lines.push('lint:');
  lines.push('  commands:');
  lines.push(yamlList(manifest.lint.commands, '    '));
  lines.push('');
  lines.push('services:');
  if (manifest.services.length === 0) lines.push('  []');
  else {
    for (const service of manifest.services) {
      lines.push(`  - name: ${service.name}`);
      lines.push(`    start: ${JSON.stringify(service.start)}`);
    }
  }
  lines.push('');
  lines.push('database:');
  lines.push('  migrate:');
  lines.push(yamlList(manifest.database.migrate, '    '));
  lines.push('  reset:');
  lines.push(yamlList(manifest.database.reset, '    '));
  lines.push('');
  return lines.join('\n');
}
