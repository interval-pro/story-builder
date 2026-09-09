import { textMessage, type AiProvider } from '@ai-engine/ai-provider';
import type { ReviewDocument, ReviewNote } from '@ai-engine/domain';
import type { Logger } from '@ai-engine/shared';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateLearningResult, type LearningResult } from '../schemas';
import { renderProjectContext, type ProjectContext } from '../context';

export interface LearningAgentInput {
  provider: AiProvider;
  projectContext: ProjectContext;
  storyBody: string;
  notes: ReviewNote[];
  reviewBefore: ReviewDocument | null;
  reviewAfter: ReviewDocument | null;
  qaSummaries: string[];
  projectRoot: string;
  logger?: Logger;
}

const RESULT_INSTRUCTION = `Produce a single JSON object with exactly this shape:

{
  "principles": [{
    "category": "architecture | code_style | testing | data_access | error_handling | security | performance | api_design | dependencies | deployment | domain_design | general",
    "statement": "the generalised principle, phrased so it applies to future work",
    "scope": "global or a module path",
    "evidence": "the correction this came from"
  }],
  "invariants": [{
    "statement": "something the system must never violate",
    "scope": "global or a module path",
    "confidence": 0.6,
    "evidence": "why this is genuinely an invariant"
  }]
}

Extract nothing rather than extracting something shallow. Return only the JSON object.`;

/**
 * Turns human corrections into reusable engineering principles. The correction
 * itself is never stored as a rule; the reasoning behind it is.
 */
export async function runLearningAgent(input: LearningAgentInput): Promise<LearningResult> {
  if (input.notes.length === 0 && input.qaSummaries.length === 0) {
    return { principles: [], invariants: [] };
  }

  const instructions = await loadAgentPrompt('learning', input.projectRoot);
  const system = [instructions, '', renderProjectContext(input.projectContext)].join('\n');

  const notes = input.notes
    .map((note, index) => `${index + 1}. On "${note.anchorText.slice(0, 200)}" the human wrote: ${note.note}`)
    .join('\n');

  const user = [
    '## Story',
    '',
    input.storyBody,
    '',
    '## Human corrections made during this task',
    '',
    notes || '(none)',
    '',
    '## What QA found',
    '',
    input.qaSummaries.map((summary) => `- ${summary}`).join('\n') || '(none)',
    '',
    'Extract the engineering reasoning behind these corrections. Do not restate the corrections.',
    'Existing principles are listed in your instructions; do not repeat one that is already there.',
  ].join('\n');

  return input.provider.structuredOutput(
    {
      system,
      messages: [textMessage('user', user), textMessage('user', RESULT_INSTRUCTION)],
      temperature: 0,
    },
    validateLearningResult,
  );
}
