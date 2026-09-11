import type { ReviewDocument, ReviewNote, Story, StoryRevision, Task } from '@ai-engine/domain';
import {
  classifyTaskSize,
  requiredSectionsFor,
  reviewBudgetFor,
  REVIEW_SECTIONS,
  REVIEW_SECTION_TITLES,
  validateReviewDocument as checkReviewDocument,
  type TaskSize,
} from '@ai-engine/domain';
import { renderProjectContext, renderReviewWithNotes, renderStoryContext, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateReviewDocument } from '../schemas';
import { renderFindingsBrief, renderResearchFindings } from './research-agent';
import type { ResearchFindings } from '../schemas';
import type { AgentRunOutcome, AgentRunner, AgentStep } from '../runner';

export interface ReviewAgentInput {
  runner: AgentRunner;
  projectContext: ProjectContext;
  story: Story;
  revision: StoryRevision;
  task: Task;
  findings: ResearchFindings;
  /**
   * Absolute path of the research findings artifact, which the prompt points at
   * instead of carrying inline. Null when no such artifact exists, in which case
   * the full findings are inlined rather than pointing the agent at nothing.
   */
  findingsPath: string | null;
  installRoot: string;
  /** Present when regenerating after human notes. */
  previousReview?: { document: ReviewDocument; notes: ReviewNote[] };
  maxIterations?: number;
  onStep?: (step: AgentStep) => Promise<void> | void;
}

function resultInstruction(size: TaskSize): string {
  const required = new Set(requiredSectionsFor(size));
  const sectionList = REVIEW_SECTIONS.map(
    (key) => `    "${key}": "${REVIEW_SECTION_TITLES[key]}"${required.has(key) ? ' (required)' : ' (optional)'}`,
  ).join(',\n');
  return `Now produce the review as a single JSON object with exactly this shape:

{
  "summary": "string, two or three sentences a reviewer can read first",
  "sections": {
${sectionList}
  },
  "implementationSteps": [{ "order": 1, "title": "string", "detail": "string", "files": ["path"] }],
  "expectedFiles": ["path"],
  "expectedSymbols": ["symbol"],
  "riskSignals": [{ "indicator": "string", "evidence": "string" }],
  "openQuestions": ["string"]
}

Each value in "sections" is the markdown body of that section, not its title. Every key must be
present. Give the optional ones an empty string unless they carry a fact the implementer needs;
an empty section is better than a restatement of another one.

${reviewBudgetFor(size).guidance}

Return only the JSON object.`;
}

/** Produces the engineering review, either the first version or a regeneration. */
export async function runReviewAgent(
  input: ReviewAgentInput,
): Promise<{ document: ReviewDocument; outcome: AgentRunOutcome<ReviewDocument>; problems: string[] }> {
  const instructions = await loadAgentPrompt('review', input.installRoot);
  const system = [
    instructions,
    '',
    renderProjectContext(input.projectContext),
    '',
    '## Workspace',
    '',
    'You can inspect the repository read-only to verify anything the research left unclear.',
  ].join('\n');

  // The research already knows how much of the repository this touches, so the
  // review is sized from it rather than treating every story as a large one.
  const size = classifyTaskSize({
    fileCount: input.findings.relevantFiles.length,
    riskSignalCount: input.findings.riskSignals.length,
  });

  // Everything that does not change between a first review and its
  // regenerations comes first: a prefix the cache can reuse is a prefix that is
  // byte-identical, and the previous review is the only part that differs.
  const userParts = [
    renderStoryContext(input.story, input.revision, input.task),
    '',
    `## Scope\n\nThis change is ${size.toLowerCase()}. ${reviewBudgetFor(size).guidance}`,
    '',
    input.findingsPath ? renderFindingsBrief(input.findings, input.findingsPath) : renderResearchFindings(input.findings),
  ];

  if (input.previousReview) {
    userParts.push(
      '',
      '---',
      '',
      '## Previous review and the human notes on it',
      '',
      renderReviewWithNotes(input.previousReview.document, input.previousReview.notes),
      '',
      'Regenerate the review so that every note is genuinely addressed. Where a note changes the shape',
      'of the solution, rewrite the affected sections rather than editing a sentence. If a note cannot',
      'be applied, say so explicitly in the open decisions section.',
    );
  } else {
    userParts.push('', 'Write the engineering review for this story.');
  }

  const outcome = await input.runner.run({
    phase: 'REVIEW',
    agentType: 'review',
    system,
    prompt: userParts.join('\n'),
    maxIterations: input.maxIterations ?? 25,
    ...(input.onStep ? { onStep: input.onStep } : {}),
    resultInstruction: resultInstruction(size),
    validate: validateReviewDocument,
  });

  return { document: outcome.result, outcome, problems: checkReviewDocument(outcome.result, size) };
}
