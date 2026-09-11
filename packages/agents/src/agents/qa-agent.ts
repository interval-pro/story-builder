import type { QaFinding, ReviewDocument, Story, StoryRevision, Task } from '@ai-engine/domain';
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
  installRoot: string;
  maxIterations?: number;
  /**
   * Continues the session of a QA attempt that failed while it still can be.
   * This never carries the implementation's session: QA opens a fresh one on
   * purpose so it cannot see the reasoning behind the code it is judging.
   */
  resumeSessionId?: string;
  /**
   * Findings earlier iterations raised that are still open.
   *
   * Each iteration is a fresh context that sees only the diff, so without this it
   * cannot know what the last one found. Two passes over nearly the same diff
   * produced disjoint blocking findings once, which is the evidence that one pass
   * does not find everything and that a finding dropped between iterations is a
   * real loss rather than a tidy-up.
   */
  carriedFindings?: QaFinding[];
  onSessionStart?: (sessionId: string) => Promise<void> | void;
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
  "notes": [{
    "summary": "one sentence: something worth knowing that you are not rejecting the change for",
    "detail": "string",
    "file": "path or null"
  }],
  "requiresSupplementalReview": false,
  "supplementalReason": "string, only when the fix would change the approved scope"
}

A finding rejects the change. A note does not: it is something a person or the next fix should know
about, and it is the right place for anything you would otherwise mention in the summary and then
have no record of. Put it in "notes" rather than in the prose, because the summary is read once and
the notes are carried forward.

Return only the JSON object.`;

/**
 * Independent review of the implementation. The QA agent gets a fresh context
 * and never sees the implementation agent's reasoning.
 */
export async function runQaAgent(
  input: QaAgentInput,
): Promise<{ report: QaReport; outcome: AgentRunOutcome<QaReport> }> {
  const instructions = await loadAgentPrompt('qa', input.installRoot);
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
    ...(input.carriedFindings && input.carriedFindings.length > 0
      ? [
          '',
          '## Findings earlier iterations raised and nobody has resolved',
          '',
          ...input.carriedFindings.map(
            (finding) => `- [${finding.severity}/${finding.category}] ${finding.summary}${finding.file ? ` (${finding.file})` : ''}`,
          ),
          '',
          'Check each of these against the diff. Raise it again if it still stands, and say so in your',
          'summary if it has been dealt with. A finding that disappears without either is how a verified',
          'defect leaves the record.',
        ]
      : []),
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
    ...(input.onSessionStart ? { onSessionStart: input.onSessionStart } : {}),
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    resultInstruction: RESULT_INSTRUCTION,
    validate: validateQaReport,
  });

  return { report: outcome.result, outcome };
}
