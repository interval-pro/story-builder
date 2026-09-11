import type { ReviewDocument, ReviewNote } from '@ai-engine/domain';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateLearningResult, type LearningResult } from '../schemas';
import { renderProjectContext, type ProjectContext } from '../context';
import type { AgentRunOutcome, AgentRunner } from '../runner';

export interface LearningAgentInput {
  runner: AgentRunner;
  projectContext: ProjectContext;
  storyBody: string;
  notes: ReviewNote[];
  reviewBefore: ReviewDocument | null;
  reviewAfter: ReviewDocument | null;
  qaSummaries: string[];
  installRoot: string;
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
 *
 * The outcome is returned alongside the result so this agent's spend is recorded
 * like every other agent's. It is null when there was nothing to learn from and
 * no engine ran at all.
 */
export async function runLearningAgent(
  input: LearningAgentInput,
): Promise<{ result: LearningResult; outcome: AgentRunOutcome<LearningResult> | null }> {
  if (input.notes.length === 0 && input.qaSummaries.length === 0) {
    return { result: { principles: [], invariants: [] }, outcome: null };
  }

  const instructions = await loadAgentPrompt('learning', input.installRoot);
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

  const outcome = await input.runner.run({
    phase: 'FINAL_REPORT',
    agentType: 'learning',
    system,
    prompt: user,
    maxIterations: 4,
    resultInstruction: RESULT_INSTRUCTION,
    validate: validateLearningResult,
  });

  return { result: outcome.result, outcome };
}
