import type { ReviewDocument, Story, StoryRevision, Task } from '@ai-engine/domain';
import { renderReviewMarkdown } from '@ai-engine/domain';
import { renderProjectContext, renderStoryContext, renderTestResults, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateQaReport, type QaReport } from '../schemas';
import type { AgentRunOutcome, AgentRunner, AgentStep } from '../runner';

export interface QaAgentInput {
  runner: AgentRunner;
  projectContext: ProjectContext;
  story: Story;
  revision: StoryRevision;
  task: Task;
  approvedReview: ReviewDocument;
  diff: string;
  testResults: { command: string; exitCode: number; output: string }[];
  iteration: number;
  projectRoot: string;
  maxIterations?: number;
  onStep?: (step: AgentStep) => Promise<void> | void;
}

const RESULT_INSTRUCTION = `Now produce your QA verdict as a single JSON object with exactly this shape:

{
  "verdict": "APPROVED | REJECTED | BLOCKED",
  "summary": "string, what you checked and what you concluded",
  "findings": [{
    "id": "finding-1",
    "category": "correctness | regression | edge_case | security | invariant | architecture | migration | tests | performance",
    "severity": "low | medium | high | blocking",
    "file": "path or null",
    "summary": "one sentence statement of the defect",
    "detail": "concrete failure scenario: inputs and state leading to the wrong outcome",
    "suggestedFix": "string"
  }],
  "requiresSupplementalReview": false,
  "supplementalReason": "string, only when the fix would change the approved scope"
}

Return only the JSON object.`;

/**
 * Independent review of the implementation. The QA agent gets a fresh context
 * and never sees the implementation agent's reasoning.
 */
export async function runQaAgent(
  input: QaAgentInput,
): Promise<{ report: QaReport; outcome: AgentRunOutcome<QaReport> }> {
  const instructions = await loadAgentPrompt('qa', input.projectRoot);
  const system = [
    instructions,
    '',
    renderProjectContext(input.projectContext),
    '',
    '## Workspace',
    '',
    'You have read-only access to the task workspace and may run the existing tests.',
    'You cannot change any code; your output is a verdict and a list of findings.',
  ].join('\n');

  const user = [
    renderStoryContext(input.story, input.revision, input.task),
    '',
    '## Approved engineering review',
    '',
    renderReviewMarkdown(input.approvedReview),
    '',
    '---',
    '',
    `## Diff (QA iteration ${input.iteration})`,
    '',
    '```diff',
    input.diff.slice(0, 200_000),
    '```',
    '',
    '## Test results',
    '',
    renderTestResults(input.testResults),
    '',
    'Review this change independently. Verify the claims in the diff against the code itself.',
  ].join('\n');

  const outcome = await input.runner.run({
    phase: 'QA',
    agentType: 'qa',
    system,
    prompt: user,
    maxIterations: input.maxIterations ?? 30,
    ...(input.onStep ? { onStep: input.onStep } : {}),
    resultInstruction: RESULT_INSTRUCTION,
    validate: validateQaReport,
  });

  return { report: outcome.result, outcome };
}
