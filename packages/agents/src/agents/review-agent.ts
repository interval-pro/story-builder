import { textMessage, type AiProvider } from '@ai-engine/ai-provider';
import type { ReviewDocument, ReviewNote, Story, StoryRevision, Task } from '@ai-engine/domain';
import { REVIEW_SECTIONS, REVIEW_SECTION_TITLES, validateReviewDocument as checkReviewDocument } from '@ai-engine/domain';
import type { ToolContext, ToolRegistry } from '@ai-engine/tools';
import type { Logger } from '@ai-engine/shared';
import { runAgentLoopWithStructuredResult, type AgentLoopResult } from '../agent-loop';
import { renderProjectContext, renderReviewWithNotes, renderStoryContext, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateReviewDocument } from '../schemas';
import { renderResearchFindings } from './research-agent';
import type { ResearchFindings } from '../schemas';

export interface ReviewAgentInput {
  provider: AiProvider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  projectContext: ProjectContext;
  story: Story;
  revision: StoryRevision;
  task: Task;
  findings: ResearchFindings;
  projectRoot: string;
  /** Present when regenerating after human notes. */
  previousReview?: { document: ReviewDocument; notes: ReviewNote[] };
  maxIterations?: number;
  logger?: Logger;
  onStep?: (step: { iteration: number; text: string; toolNames: string[] }) => Promise<void> | void;
}

function resultInstruction(): string {
  const sectionList = REVIEW_SECTIONS.map((key) => `    "${key}": "${REVIEW_SECTION_TITLES[key]}"`).join(',\n');
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

Each value in "sections" is the markdown body of that section, not its title.
Return only the JSON object.`;
}

/** Produces the engineering review, either the first version or a regeneration. */
export async function runReviewAgent(
  input: ReviewAgentInput,
): Promise<{ document: ReviewDocument; loop: AgentLoopResult; problems: string[] }> {
  const instructions = await loadAgentPrompt('review', input.projectRoot);
  const system = [
    instructions,
    '',
    renderProjectContext(input.projectContext),
    '',
    '## Workspace',
    '',
    'You can inspect the repository read-only to verify anything the research left unclear.',
  ].join('\n');

  const userParts = [renderStoryContext(input.story, input.revision, input.task), '', renderResearchFindings(input.findings)];

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

  const { loop, result } = await runAgentLoopWithStructuredResult({
    provider: input.provider,
    registry: input.registry,
    toolContext: input.toolContext,
    system,
    initialMessages: [textMessage('user', userParts.join('\n'))],
    maxIterations: input.maxIterations ?? 25,
    logger: input.logger,
    onStep: input.onStep,
    resultInstruction: resultInstruction(),
    validate: validateReviewDocument,
  });

  return { document: result, loop, problems: checkReviewDocument(result) };
}
