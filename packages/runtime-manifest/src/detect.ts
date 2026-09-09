import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@ai-engine/shared';
import type { RuntimeManifestDocument } from '@ai-engine/domain';

const logger = createLogger('runtime-manifest');

export function emptyManifest(): RuntimeManifestDocument {
  return {
    project: { language: [], packageManager: null },
    setup: { commands: [] },
    build: { commands: [] },
    test: { commands: [] },
    lint: { commands: [] },
    services: [],
    database: { migrate: [], reset: [] },
  };
}

async function readIfExists(root: string, relative: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relative), 'utf8');
  } catch {
    return null;
  }
}

async function exists(root: string, relative: string): Promise<boolean> {
  try {
    await stat(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

/** Picks the package manager from the lock file that is actually committed. */
async function detectNodePackageManager(root: string): Promise<{ manager: string; install: string }> {
  if (await exists(root, 'pnpm-lock.yaml')) return { manager: 'pnpm', install: 'pnpm install --frozen-lockfile' };
  if (await exists(root, 'yarn.lock')) return { manager: 'yarn', install: 'yarn install --frozen-lockfile' };
  if (await exists(root, 'package-lock.json')) return { manager: 'npm', install: 'npm ci' };
  return { manager: 'npm', install: 'npm install' };
}

async function detectNode(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  const raw = await readIfExists(root, 'package.json');
  if (!raw) return;
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const { manager, install } = await detectNodePackageManager(root);

  manifest.project.language.push(
    (await exists(root, 'tsconfig.json')) || (await exists(root, 'tsconfig.base.json')) ? 'typescript' : 'javascript',
  );
  manifest.project.packageManager = manager;
  manifest.setup.commands.push(install);

  const run = (script: string) => (manager === 'npm' ? `npm run ${script}` : `${manager} ${script}`);
  if (scripts['build']) manifest.build.commands.push(run('build'));
  if (scripts['test']) manifest.test.commands.push(manager === 'npm' ? 'npm test' : `${manager} test`);
  if (scripts['lint']) manifest.lint.commands.push(run('lint'));
  if (scripts['typecheck']) manifest.lint.commands.push(run('typecheck'));
  for (const key of ['migrate', 'db:migrate', 'migration:run']) {
    if (scripts[key]) manifest.database.migrate.push(run(key));
  }
  for (const key of ['db:reset', 'db:drop', 'migration:revert']) {
    if (scripts[key]) manifest.database.reset.push(run(key));
  }
}

async function detectPython(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  const pyproject = await readIfExists(root, 'pyproject.toml');
  const requirements = await readIfExists(root, 'requirements.txt');
  if (!pyproject && !requirements) return;
  manifest.project.language.push('python');
  if (pyproject && pyproject.includes('[tool.poetry]')) {
    manifest.project.packageManager = 'poetry';
    manifest.setup.commands.push('poetry install');
    manifest.test.commands.push('poetry run pytest');
  } else {
    manifest.project.packageManager = manifest.project.packageManager ?? 'pip';
    if (requirements) manifest.setup.commands.push('pip install -r requirements.txt');
    else manifest.setup.commands.push('pip install -e .');
    manifest.test.commands.push('pytest');
  }
  if (pyproject && pyproject.includes('ruff')) manifest.lint.commands.push('ruff check .');
  if (await exists(root, 'manage.py')) manifest.database.migrate.push('python manage.py migrate');
  if (await exists(root, 'alembic.ini')) manifest.database.migrate.push('alembic upgrade head');
}

async function detectGo(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  if (!(await exists(root, 'go.mod'))) return;
  manifest.project.language.push('go');
  manifest.setup.commands.push('go mod download');
  manifest.build.commands.push('go build ./...');
  manifest.test.commands.push('go test ./...');
  manifest.lint.commands.push('go vet ./...');
}

async function detectRust(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  if (!(await exists(root, 'Cargo.toml'))) return;
  manifest.project.language.push('rust');
  manifest.setup.commands.push('cargo fetch');
  manifest.build.commands.push('cargo build');
  manifest.test.commands.push('cargo test');
  manifest.lint.commands.push('cargo clippy');
}

async function detectDotnet(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  if (!entries.some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) return;
  manifest.project.language.push('csharp');
  manifest.setup.commands.push('dotnet restore');
  manifest.build.commands.push('dotnet build');
  manifest.test.commands.push('dotnet test');
}

async function detectJava(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  if (await exists(root, 'pom.xml')) {
    manifest.project.language.push('java');
    manifest.setup.commands.push('mvn -B dependency:go-offline');
    manifest.build.commands.push('mvn -B package -DskipTests');
    manifest.test.commands.push('mvn -B test');
    return;
  }
  if ((await exists(root, 'build.gradle')) || (await exists(root, 'build.gradle.kts'))) {
    manifest.project.language.push('java');
    manifest.build.commands.push('./gradlew build -x test');
    manifest.test.commands.push('./gradlew test');
  }
}

async function detectServices(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const raw = await readIfExists(root, file);
    if (!raw) continue;
    const names = [...raw.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gim)].map((match) => match[1]!).slice(0, 12);
    for (const name of names) {
      manifest.services.push({ name, start: `docker compose up -d ${name}` });
    }
    break;
  }
}

async function detectMakefile(root: string, manifest: RuntimeManifestDocument): Promise<void> {
  const raw = await readIfExists(root, 'Makefile');
  if (!raw) return;
  const targets = new Set([...raw.matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((match) => match[1]!));
  if (targets.has('build') && manifest.build.commands.length === 0) manifest.build.commands.push('make build');
  if (targets.has('test') && manifest.test.commands.length === 0) manifest.test.commands.push('make test');
  if (targets.has('lint') && manifest.lint.commands.length === 0) manifest.lint.commands.push('make lint');
  if (targets.has('migrate') && manifest.database.migrate.length === 0) manifest.database.migrate.push('make migrate');
}

/**
 * Derives how to build, test and run a project from whatever it actually
 * contains. The system stays language agnostic by never assuming a stack.
 */
export async function detectRuntimeManifest(projectRoot: string): Promise<RuntimeManifestDocument> {
  const manifest = emptyManifest();
  await detectNode(projectRoot, manifest);
  await detectPython(projectRoot, manifest);
  await detectGo(projectRoot, manifest);
  await detectRust(projectRoot, manifest);
  await detectDotnet(projectRoot, manifest);
  await detectJava(projectRoot, manifest);
  await detectMakefile(projectRoot, manifest);
  await detectServices(projectRoot, manifest);

  manifest.project.language = [...new Set(manifest.project.language)];
  manifest.setup.commands = [...new Set(manifest.setup.commands)];
  manifest.build.commands = [...new Set(manifest.build.commands)];
  manifest.test.commands = [...new Set(manifest.test.commands)];
  manifest.lint.commands = [...new Set(manifest.lint.commands)];

  logger.info('runtime manifest detected', {
    languages: manifest.project.language,
    hasTests: manifest.test.commands.length > 0,
  });
  return manifest;
}
