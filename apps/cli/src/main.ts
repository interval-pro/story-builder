import path from 'node:path';
import { failure, heading, info } from './output';
import { initCommand } from './commands/init';
import { exportCommand, importCommand, startCommand, statusCommand, stopCommand } from './commands/lifecycle';
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
  ai-engine init [--repo <path>] [--skip-docker]   Install the system into a repository
  ai-engine start                                  Start the stack with docker compose
  ai-engine stop                                   Stop the stack
  ai-engine status                                 Show system and task status
  ai-engine story create --body "..." [--title t] [--system]
  ai-engine task list
  ai-engine task show <taskId>
  ai-engine export <file>                          Export the portable project state
  ai-engine import <file>                          Import a previously exported state
  ai-engine update                                 Show how to upgrade the vendored system
  ai-engine rollback                               Show how to roll back to a known-good version
`);
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const repoPath = path.resolve(String(flags['repo'] ?? process.env['PROJECT_ROOT'] ?? process.cwd()));

  switch (command) {
    case 'init':
      return initCommand({ repoPath, skipDocker: Boolean(flags['skip-docker']) });
    case 'start':
      return startCommand(repoPath);
    case 'stop':
      return stopCommand(repoPath);
    case 'status':
      return statusCommand(repoPath);
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
        kind: flags['system'] ? 'SYSTEM_TASK' : 'PROJECT_TASK',
      });
    }
    case 'task': {
      const sub = positional[0];
      if (sub === 'list') return taskListCommand();
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
      return exportCommand(path.resolve(target));
    }
    case 'import': {
      const source = positional[0];
      if (!source) {
        failure('Usage: ai-engine import <file>');
        return 1;
      }
      return importCommand(path.resolve(source));
    }
    case 'update':
      info('\nThe system is vendored in .ai-engineering. Install a candidate version side by side under');
      info('.ai-engineering/versions/<version>, run its migrations and self tests, and only then switch');
      info('the "current" pointer. The active version is never overwritten in place.\n');
      return 0;
    case 'rollback':
      info('\nSwitch .ai-engineering/current back to a known-good version and restore the state snapshot');
      info('that was taken before the upgrade. At least three known-good versions are kept.\n');
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
