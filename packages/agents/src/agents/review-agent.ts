import type { ReviewDocument, ReviewNote, Story, StoryRevision, Task } from '@ai-engine/domain';
import {
  classifyTaskSize,
  mergeReviewDocument,
  requiredSectionsFor,
  reviewBudgetFor,
  REVIEW_SECTIONS,
  REVIEW_SECTION_TITLES,
  validateReviewDocument as checkReviewDocument,
  type TaskSize,
} from '@ai-engine/domain';
import { renderProjectContext, renderReviewWithNotes, renderStoryContext, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateReviewDocument, validateReviewPatch } from '../schemas';
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
  /**
   * Continues the research conversation instead of opening a cold one. The two
   * run back to back in the same job over the same worktree, so a cold review
   * pays to read a repository that was just read.
   *
   * The prompt shape does not change when this is set, which is what makes the
   * cold path trivially correct: if the id is null or the resume fails, the
   * retry reaches the findings-reuse branch and runs cold with the same prompt.
   *
   * `--resume` alongside `--append-system-prompt` and a changed `--effort` is
   * already exercised by the fix cycle. `--add-dir` on a resumed session is
   * documented by `claude --help` as an unconditional option, but was not
   * confirmed by running it; if it turns out to be dropped, the resumed review
   * is pointed at a findings file it cannot read and review_findings_unread
   * fires, which is the loud signal either way. The fix is to pass
   * findingsPath: null when resuming, which inlines the findings instead.
   */
  resumeSessionId?: string;
  maxIterations?: number;
  onSessionStart?: (sessionId: string) => Promise<void> | void;
  onStep?: (step: AgentStep) => Promise<void> | void;
}

function sectionCatalog(size: TaskSize): string {
  const required = new Set(requiredSectionsFor(size));
  return REVIEW_SECTIONS.map(
    (key) => `    "${key}": "${REVIEW_SECTION_TITLES[key]}"${required.has(key) ? ' (required)' : ' (optional)'}`,
  ).join(',\n');
}

function resultInstruction(size: TaskSize): string {
  return `Now produce the review as a single JSON object with exactly this shape:

{
  "summary": "string, two or three sentences a reviewer can read first",
  "sections": {
${sectionCatalog(size)}
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

/**
 * A regeneration returns a patch, not a new document.
 *
 * Reproducing all twenty two sections to change three is most of what answering
 * a note costs, and a section rewritten into something equivalent also shows up
 * as changed in the version diff, which hides the sections that genuinely moved.
 */
function patchResultInstruction(size: TaskSize): string {
  return `Now return only the parts of the review you are changing, as a single JSON object:

{
  "summary": "string, only if the summary itself has to change",
  "sections": {
    "<key of a section you are changing>": "the full new markdown body of that section"
  },
  "implementationSteps": [{ "order": 1, "title": "string", "detail": "string", "files": ["path"] }],
  "expectedFiles": ["path"],
  "expectedSymbols": ["symbol"],
  "riskSignals": [{ "indicator": "string", "evidence": "string" }],
  "openQuestions": ["string"]
}

Include a section key only if you are changing that section. A key you include replaces that
section's entire body, so write the whole body out rather than a fragment or a description of the
edit. A key you leave out keeps the previous version's body exactly as it was, which is what you
want for every section the notes did not affect. To empty a section, include its key with an empty
string.

Leave out every top-level field you are not changing too. "implementationSteps", "expectedFiles",
"expectedSymbols", "riskSignals" and "openQuestions" each replace the previous list in full when
present, so include one only if the list itself changes, and then give all of its entries.

The section keys are:

{
${sectionCatalog(size)}
}

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

  const previousReview = input.previousReview;
  if (previousReview) {
    userParts.push(
      '',
      '---',
      '',
      '## Previous review and the human notes on it',
      '',
      renderReviewWithNotes(previousReview.document, previousReview.notes),
      '',
      'Regenerate the review so that every note is genuinely addressed. Where a note changes the shape',
      'of the solution, rewrite the affected sections rather than editing a sentence. If a note cannot',
      'be applied, say so explicitly in the open decisions section.',
      '',
      'Emit every section a note invalidates, not only the section the note is anchored to. A note about',
      'the approach usually also changes the risks, the trade-offs, the testing strategy and the plan;',
      'a section you do not emit keeps its previous wording, so anything left stale stays stale.',
    );
  } else {
    userParts.push('', 'Write the engineering review for this story.');
  }

  // A regeneration is asked for a patch and it is merged over the version it was
  // written against, here at the validate seam: it is the last point a caller
  // controls, and the only one that holds both the patch and the previous
  // document. Everything downstream still receives a complete ReviewDocument.
  const validate = previousReview
    ? (value: unknown): ReviewDocument => mergeReviewDocument(previousReview.document, validateReviewPatch(value))
    : validateReviewDocument;

  const outcome = await input.runner.run({
    phase: 'REVIEW',
    agentType: 'review',
    system,
    prompt: userParts.join('\n'),
    maxIterations: input.maxIterations ?? 25,
    ...(input.onStep ? { onStep: input.onStep } : {}),
    ...(input.onSessionStart ? { onSessionStart: input.onSessionStart } : {}),
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    resultInstruction: previousReview ? patchResultInstruction(size) : resultInstruction(size),
    validate,
  });

  return { document: outcome.result, outcome, problems: checkReviewDocument(outcome.result, size) };
}
