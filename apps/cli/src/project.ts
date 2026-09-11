import type { Project } from '@ai-engine/domain';
import type { Repositories } from '@ai-engine/db';
import { failure, info } from './output';

/**
 * Which project a command is about.
 *
 * An installation serves several repositories now, so picking the first one and
 * carrying on is how work quietly lands against the wrong project. One project
 * needs no asking; two and no answer is a real ambiguity and the command says so,
 * by name, rather than guessing.
 *
 * Returns null after having already explained the problem, so a caller only has
 * to stop.
 */
export async function resolveProject(
  repos: Repositories,
  options: { project?: string | undefined; installation?: boolean },
): Promise<Project | null> {
  if (options.installation) {
    const installation = await repos.projects.findInstallation();
    if (!installation) {
      failure('This installation is not registered as a project. Run "ai-engine init" again.');
    }
    return installation;
  }

  const projects = await repos.projects.listWorkProjects();
  if (projects.length === 0) {
    failure('No project is registered. Add one from the cockpit, or run "ai-engine init --repo <path>".');
    return null;
  }

  if (options.project) {
    const wanted = options.project.toLowerCase();
    const named = projects.find(
      (project) => project.id === options.project || project.name.toLowerCase() === wanted,
    );
    if (named) return named;
    failure(`No project called "${options.project}". The ones registered are:`);
    for (const project of projects) info(`  ${project.name}  ${project.repoPath}`);
    return null;
  }

  if (projects.length === 1) return projects[0]!;

  failure(`This installation serves ${projects.length} projects, so say which one with --project <name>:`);
  for (const project of projects) info(`  ${project.name}  ${project.repoPath}`);
  return null;
}
