import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages');

/**
 * Runs the test suite directly against the TypeScript sources, so tests do not
 * need a build. Production always loads the compiled entry point named in each
 * package.json.
 */
const sourceEntries = new Map();
for (const name of readdirSync(packagesRoot)) {
  const entry = path.join(packagesRoot, name, 'src', 'index.ts');
  if (existsSync(entry)) sourceEntries.set(`@ai-engine/${name}`, pathToFileURL(entry).href);
}

/** The sources use TypeScript style extensionless relative imports. */
function resolveRelativeSource(specifier, parentURL) {
  if (!specifier.startsWith('.') || !parentURL || !parentURL.startsWith('file:')) return null;
  const base = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  const mapped = sourceEntries.get(specifier);
  if (mapped) return { url: mapped, shortCircuit: true, format: 'module-typescript' };

  if (specifier.startsWith('.') && !path.extname(specifier)) {
    const relative = resolveRelativeSource(specifier, context.parentURL);
    if (relative) return { url: relative, shortCircuit: true, format: 'module-typescript' };
  }

  return nextResolve(specifier, context);
}
