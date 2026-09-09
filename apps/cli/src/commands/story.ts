import { readFile } from 'node:fs/promises';
import { Database, createRepositories } from '@ai-engine/db';
import { TaskCommands } from '@ai-engine/orchestrator';
import { failure, heading, info, success, table } from '../output';

/** Creates a story from the command line, for scripting and for system stories. */
export async function storyCreateCommand(options: {
  body?: string;
  file?: string;
  title?: string;
  kind: 'PROJECT_TASK' | 'SYSTEM_TASK';
}): Promise<number> {
  const db = new Database();
  try {
    const body = options.file ? await readFile(options.file, 'utf8') : options.body;
    if (!body || body.trim().length < 10) {
      failure('Provide a story with --body "..." or --file path');
      return 1;
    }
    const repos = createRepositories(db);
    const project = await repos.projects.findPrimary();
    if (!project) {
      failure('No project is registered. Run "ai-engine init" first.');
      return 1;
    }
    const commands = new TaskCommands(db);
    const result = await commands.createStory({
      projectId: project.id,
      body,
      ...(options.title ? { title: options.title } : {}),
      kind: options.kind,
      actor: { type: 'human', id: 'cli' },
    });
    heading('Story created');
    table([
      ['Story', result.story.id],
      ['Task', result.task.id],
      ['Branch', result.task.branchName],
      ['Base commit', result.task.baseCommit.slice(0, 10)],
      ['State', result.task.state],
    ]);
    success('Analysis has been queued.');
    return 0;
  } finally {
    await db.close();
  }
}

export async function taskListCommand(): Promise<number> {
  const db = new Database();
  try {
    const repos = createRepositories(db);
    const project = await repos.projects.findPrimary();
    if (!project) {
      failure('No project is registered.');
      return 1;
    }
    const tasks = await repos.tasks.listByProject(project.id, 50);
    heading(`Tasks (${tasks.length})`);
    for (const task of tasks) {
      const story = await repos.stories.getById(task.storyId);
      info(`  ${task.id.slice(0, 8)}  ${task.state.padEnd(28)} ${story.title.slice(0, 60)}`);
    }
    return 0;
  } finally {
    await db.close();
  }
}

export async function taskShowCommand(taskId: string): Promise<number> {
  const db = new Database();
  try {
    const repos = createRepositories(db);
    const task = await repos.tasks.getById(taskId);
    const story = await repos.stories.getById(task.storyId);
    const review = await repos.reviews.findCurrentForTask(task.id);
    const version = review ? await repos.reviews.getLatestVersion(review.id) : null;

    heading(story.title);
    table([
      ['Task', task.id],
      ['State', task.state],
      ['Risk', task.riskLevel ?? 'not assessed'],
      ['Branch', task.branchName],
      ['Base', `${task.baseBranch} @ ${task.baseCommit.slice(0, 10)}`],
      ['QA iterations', String(task.qaIteration)],
      ['Blocked', task.blockedReason ?? 'no'],
    ]);

    if (version) {
      heading(`Review v${version.version}`);
      info(version.markdown.slice(0, 4000));
    }
    return 0;
  } finally {
    await db.close();
  }
}
