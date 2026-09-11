import { indent } from '@ai-engine/shared';
import { renderProjectContext, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateIntakeResult, type IntakeResult } from '../schemas';
import type { AgentRunOutcome, AgentRunner } from '../runner';

export interface AnsweredIntakeQuestion {
  question: string;
  answer: string;
}

export interface IntakeAgentInput {
  runner: AgentRunner;
  projectContext: ProjectContext;
  /** What the person wrote, unedited. */
  idea: string;
  /** Rounds already answered, oldest first. */
  answers: AnsweredIntakeQuestion[];
  /** Which round this is, counting from one. */
  round: number;
  /** After this round the agent must produce stories rather than ask again. */
  finalRound: boolean;
  installRoot: string;
  onSessionStart?: (sessionId: string) => Promise<void> | void;
  /** Continues the earlier rounds instead of re-reading the repository. */
  resumeSessionId?: string;
}

const RESULT_INSTRUCTION = `Return a single JSON object with exactly this shape:

{
  "understanding": "string, two or three sentences: what you take the idea to be, in your own words",
  "questions": [
    {
      "question": "string, one thing you need decided",
      "rationale": "string, why the answer changes what gets built",
      "options": [{ "key": "short-slug", "label": "string, the choice in a few words", "detail": "string, what it means in practice" }]
    }
  ],
  "stories": [
    { "title": "string, one line", "body": "string, the story as behaviour to change", "rationale": "string, why this is its own story" }
  ]
}

Return questions or stories, never both. Ask only what you cannot settle by reading the
repository, at most three questions, each with two or three options. A question with one option
is not a question, and a fourth option is a form rather than a choice.

Once you can write the stories, return them and no questions. Each story describes behaviour to
change, in the language the person used, not an implementation. Split into several stories only
where they could genuinely ship separately, and say why in the rationale.

Return only the JSON object.`;

const FINAL_ROUND_INSTRUCTION = `${RESULT_INSTRUCTION}

This is the last round. Return stories. If something is still undecided, choose the reading you
think is right, write the story for it, and say in that story's rationale what you assumed.`;

/**
 * Turns an idea into stories, asking first when asking is cheaper than guessing.
 *
 * This is the step before the pipeline rather than part of it: nothing has a
 * branch yet, nothing is researched in depth, and the output is text a person
 * edits. Its whole value is catching the two failures that are expensive later —
 * an idea that is really four stories, and an idea described so thinly that the
 * research pass has to invent what it means.
 */
export async function runIntakeAgent(
  input: IntakeAgentInput,
): Promise<{ result: IntakeResult; outcome: AgentRunOutcome<IntakeResult> }> {
  const instructions = await loadAgentPrompt('intake', input.installRoot);
  const system = [
    instructions,
    '',
    renderProjectContext(input.projectContext),
    '',
    '## Workspace',
    '',
    'You are in the repository this idea is about, read-only. Read enough of it to ask about this',
    'codebase rather than about software in general, and no more: this step is cheap on purpose.',
  ].join('\n');

  const parts = ['## The idea', '', indent(input.idea, 2)];

  if (input.answers.length > 0) {
    parts.push(
      '',
      '## Already answered',
      '',
      ...input.answers.map((answer) => `- ${answer.question}\n  ${answer.answer}`),
      '',
      'Do not ask any of these again, and do not ask something an answer above already settles.',
    );
  }

  parts.push('', `This is round ${input.round}.`);

  const outcome = await input.runner.run({
    phase: 'INTAKE',
    agentType: 'intake',
    system,
    prompt: parts.join('\n'),
    maxIterations: 12,
    resultInstruction: input.finalRound ? FINAL_ROUND_INSTRUCTION : RESULT_INSTRUCTION,
    validate: validateIntakeResult,
    ...(input.onSessionStart ? { onSessionStart: input.onSessionStart } : {}),
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
  });

  return { result: outcome.result, outcome };
}
