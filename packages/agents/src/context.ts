import { indent } from '@ai-engine/shared';
import type {
  Invariant,
  ProjectKind,
  Principle,
  ReviewDocument,
  ReviewNote,
  RuntimeManifestDocument,
  Story,
  StoryRevision,
  Task,
} from '@ai-engine/domain';
import { renderReviewMarkdown } from '@ai-engine/domain';

export interface ProjectContext {
  kind: ProjectKind;
  principles: Principle[];
  invariants: Invariant[];
  runtimeManifest: RuntimeManifestDocument | null;
  knowledgeSummary: string | null;
}

/** Renders the Project Brain so every agent works from the same shared memory. */
export function renderProjectContext(context: ProjectContext): string {
  const parts: string[] = [];

  if (context.kind === 'INSTALLATION') {
    parts.push(
      [
        '## What this repository is',
        '',
        'This repository is the AI engineering system itself, installed as the engine that runs',
        'these tasks. Work here changes how the system behaves for the project it serves. It is',
        'applied locally and the engine is restarted onto it; nothing is pushed anywhere.',
      ].join('\n'),
    );
  }

  if (context.principles.length > 0) {
    const grouped = new Map<string, Principle[]>();
    for (const principle of context.principles) {
      const list = grouped.get(principle.category) ?? [];
      list.push(principle);
      grouped.set(principle.category, list);
    }
    const rendered = [...grouped.entries()]
      .map(([category, items]) => `${category}:\n${items.map((item) => `  - ${item.statement}`).join('\n')}`)
      .join('\n');
    parts.push(`## Project principles\n\nHow this team makes engineering decisions.\n\n${rendered}`);
  }

  if (context.invariants.length > 0) {
    const rendered = context.invariants.map((invariant) => `- ${invariant.statement} (${invariant.scope})`).join('\n');
    parts.push(`## System invariants\n\nThese must never be violated.\n\n${rendered}`);
  }

  if (context.runtimeManifest) {
    const manifest = context.runtimeManifest;
    const lines = [
      `languages: ${manifest.project.language.join(', ') || 'unknown'}`,
      `setup: ${manifest.setup.commands.join(' && ') || 'unknown'}`,
      `build: ${manifest.build.commands.join(' && ') || 'unknown'}`,
      `test: ${manifest.test.commands.join(' && ') || 'unknown'}`,
      `lint: ${manifest.lint.commands.join(' && ') || 'none'}`,
      `migrate: ${manifest.database.migrate.join(' && ') || 'none'}`,
    ];
    parts.push(`## Project runtime\n\n${lines.join('\n')}`);
  }

  if (context.knowledgeSummary) {
    parts.push(`## Project knowledge\n\n${context.knowledgeSummary}`);
  }

  return parts.join('\n\n');
}

export function renderStoryContext(story: Story, revision: StoryRevision, task: Task): string {
  return [
    '## Story',
    '',
    `Title: ${story.title}`,
    `Revision: ${revision.revision}`,
    `Base branch: ${task.baseBranch}`,
    `Base commit: ${task.baseCommit}`,
    '',
    'Story text:',
    '',
    indent(revision.body, 2),
  ].join('\n');
}

/** Human notes are shown anchored to the fragment they were written against. */
export function renderReviewWithNotes(document: ReviewDocument, notes: ReviewNote[]): string {
  const markdown = renderReviewMarkdown(document);
  if (notes.length === 0) return markdown;
  const rendered = notes
    .map((note, index) => {
      const section = note.sectionKey ? ` [section: ${note.sectionKey}]` : '';
      return [
        `### Note ${index + 1}${section}`,
        '',
        'The human selected this fragment of the review:',
        '',
        indent(note.anchorText, 2),
        '',
        'and wrote:',
        '',
        indent(note.note, 2),
      ].join('\n');
    })
    .join('\n\n');
  return `${markdown}\n\n---\n\n## Human review notes\n\n${rendered}`;
}

export function renderTestResults(results: { command: string; exitCode: number; output: string }[]): string {
  if (results.length === 0) return 'No test runs were recorded for this task.';
  return results
    .map((result) => `$ ${result.command}\nexit code: ${result.exitCode}\n\n${result.output.slice(0, 8000)}`)
    .join('\n\n---\n\n');
}
