import path from 'node:path';
import { failure, heading, info } from './output';
import { initCommand } from './commands/init';
import {
  exportCommand,
  importCommand,
  startCommand,
  statusCommand,
  stopCommand,
  versionCommand,
} from './commands/lifecycle';
import { storyCreateCommand, taskListCommand, taskShowCommand } from './commands/story';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        index++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function usage(): void {
  heading('ai-engine');
  info(`
  ai-engine init [--repo <path>] [--skip-docker]   Register the installation, optionally with a project
  ai-engine version                                Show the installed version and upstream drift
  ai-engine start                                  Start the stack with docker compose
  ai-engine stop                                   Stop the stack
  ai-engine status [--project <name>]              Show system and task status
  ai-engine story create --body "..." [--title t] [--installation] [--project name]
  ai-engine task list [--project name]
  ai-engine task show <taskId>
  ai-engine export <file>                          Export the portable project state
  ai-engine import <file>                          Import a previously exported state
  ai-engine update                                 Show how to move to a newer release
  ai-engine rollback                               Show how to roll back to a known-good version
`);
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  // A repository is optional: an installation serves as many projects as are
  // added to it from the cockpit, so `init` with none is the normal first step.
  const repoFlag = flags['repo'] ?? process.env['PROJECT_ROOT'];
  const repoPath = typeof repoFlag === 'string' && repoFlag.length > 0 ? path.resolve(repoFlag) : null;
  const installRoot = path.resolve(String(flags['install-root'] ?? process.env['INSTALL_ROOT'] ?? process.cwd()));
  // Which project a command is about, when the installation serves several.
  const project = typeof flags['project'] === 'string' ? flags['project'] : undefined;

  switch (command) {
    case 'init':
      return initCommand({ repoPath, installRoot, skipDocker: Boolean(flags['skip-docker']) });
    case 'version':
      return versionCommand();
    case 'start':
      return startCommand(repoPath ?? installRoot);
    case 'stop':
      return stopCommand(repoPath ?? installRoot);
    case 'status':
      return statusCommand(repoPath ?? installRoot, { project });
    case 'story': {
      const sub = positional[0];
      if (sub !== 'create') {
        failure('Usage: ai-engine story create --body "..."');
        return 1;
      }
      return storyCreateCommand({
        ...(typeof flags['body'] === 'string' ? { body: flags['body'] } : {}),
        ...(typeof flags['file'] === 'string' ? { file: flags['file'] } : {}),
        ...(typeof flags['title'] === 'string' ? { title: flags['title'] } : {}),
        installation: Boolean(flags['installation']),
        project,
      });
    }
    case 'task': {
      const sub = positional[0];
      if (sub === 'list') return taskListCommand({ project });
      if (sub === 'show' && positional[1]) return taskShowCommand(positional[1]);
      failure('Usage: ai-engine task list | ai-engine task show <taskId>');
      return 1;
    }
    case 'export': {
      const target = positional[0];
      if (!target) {
        failure('Usage: ai-engine export <file>');
        return 1;
      }
      return exportCommand(path.resolve(target), { project });
    }
    case 'import': {
      const source = positional[0];
      if (!source) {
        failure('Usage: ai-engine import <file>');
        return 1;
      }
      return importCommand(path.resolve(source), { project });
    }
    case 'update':
      info('\nUpdate from the cockpit: System Status shows an update button whenever the installation is');
      info('behind the newest release. It stops the services, fetches the release, rebuilds, migrates, runs');
      info('the tests and starts everything again, restoring the current version if any step fails.\n');
      return 0;
    case 'rollback':
      info('\nCheck the previous release tag out inside the installation, rebuild it and restore the state');
      info('snapshot taken before the upgrade.\n');
      return 0;
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      failure(`Unknown command: ${command}`);
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    failure(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
