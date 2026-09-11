import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewDocument, Story, StoryRevision, Task } from '@ai-engine/domain';
import { runReviewAgent } from '../src/agents/review-agent.ts';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '../src/runner.ts';
import type { ResearchFindings } from '../src/schemas.ts';

/** In the full findings and nowhere in the digest, so a leak is unmistakable. */
const BURIED = 'MARKER-ONLY-IN-THE-FULL-FINDINGS';

const FINDINGS_PATH = '/state/artifacts/project-1/task-1/research_findings/abc.md';

const FINDINGS: ResearchFindings = {
  summary: 'The denial lives in one pure function and the answer pass repeats it.',
  relevantFiles: [
    { path: 'packages/claude-code/src/phase-policy.ts', why: 'the only per-phase denial site' },
    { path: 'packages/claude-code/src/agent-runner.ts', why: 'holds the second deny list' },
  ],
  relevantSymbols: [{ name: 'policyForPhase', path: 'packages/claude-code/src/phase-policy.ts', why: BURIED }],
  executionPaths: [`the runner calls the policy and then the CLI, ${BURIED}`],
  databaseNotes: [`task_runs keeps two token counts, ${BURIED}`],
  testNotes: [`phase-policy.test.ts covers the work pass only, ${BURIED}`],
  dependencyNotes: [`nothing new is needed, ${BURIED}`],
  externalFindings: [{ source: 'tools.md', trustTier: 1, claim: BURIED, validation: BURIED }],
  openQuestions: ['whether the CLI exposes a concurrency flag'],
  riskSignals: [{ indicator: 'core_shared_module', evidence: 'every phase of every task goes through it' }],
};

const STORY = { id: 'story-1', title: 'Spend fewer tokens' } as Story;
const REVISION = { revision: 1, body: 'Deny delegation and stop re-sending the findings.' } as StoryRevision;
const TASK = { id: 'task-1', baseBranch: 'main', baseCommit: 'd07242a' } as Task;

const DOCUMENT = {
  summary: 'A review.',
  sections: { story_understanding: 'Understood.' },
  implementationSteps: [{ order: 1, title: 'Do it', detail: 'As described', files: ['a.ts'] }],
  expectedFiles: ['a.ts'],
  expectedSymbols: ['policyForPhase'],
  riskSignals: [],
  openQuestions: [],
};

/** Captures the prompt the review agent would have been sent. */
function capturingRunner(): { runner: AgentRunner; prompt: () => string } {
  let captured = '';
  const runner: AgentRunner = {
    kind: 'capturing',
    async run<T>(request: AgentRunRequest<T>): Promise<AgentRunOutcome<T>> {
      captured = request.prompt;
      return {
        result: request.validate(DOCUMENT),
        transcript: '',
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        sessionId: null,
        costUsd: null,
        modelUsage: null,
        subagentStats: null,
        permissionDenials: [],
      };
    },
  };
  return { runner, prompt: () => captured };
}

async function promptFor(
  previousReview?: { document: ReviewDocument; notes: [] },
): Promise<{ prompt: string; document: ReviewDocument }> {
  const { runner, prompt } = capturingRunner();
  const { document } = await runReviewAgent({
    runner,
    projectContext: { kind: 'PROJECT', principles: [], invariants: [], runtimeManifest: null, knowledgeSummary: null },
    story: STORY,
    revision: REVISION,
    task: TASK,
    findings: FINDINGS,
    findingsPath: FINDINGS_PATH,
    // No prompt files under this root, so the built-in agent text is used and the
    // test does not depend on the installation's own prompts.
    installRoot: '/nonexistent-install-root',
    ...(previousReview ? { previousReview } : {}),
  });
  return { prompt: prompt(), document };
}

test('the review prompt carries the digest and a pointer, not the whole findings', async () => {
  const { prompt } = await promptFor();

  assert.ok(prompt.includes(FINDINGS.summary), 'the summary must stay inline');
  for (const file of FINDINGS.relevantFiles) {
    assert.ok(prompt.includes(file.path), `${file.path} must stay inline`);
  }
  for (const signal of FINDINGS.riskSignals) {
    assert.ok(prompt.includes(signal.indicator), `the ${signal.indicator} risk signal must stay inline`);
  }
  for (const question of FINDINGS.openQuestions) {
    assert.ok(prompt.includes(question), 'every open question must stay inline');
  }
  assert.ok(prompt.includes(FINDINGS_PATH), 'the agent must be told where to read the rest');
  assert.ok(!prompt.includes(BURIED), 'nothing behind the pointer may be sent inline');
});

test('with no artifact to point at, the full findings are inlined rather than lost', async () => {
  const { runner, prompt } = capturingRunner();
  await runReviewAgent({
    runner,
    projectContext: { kind: 'PROJECT', principles: [], invariants: [], runtimeManifest: null, knowledgeSummary: null },
    story: STORY,
    revision: REVISION,
    task: TASK,
    findings: FINDINGS,
    findingsPath: null,
    installRoot: '/nonexistent-install-root',
  });
  assert.ok(prompt().includes(BURIED), 'without a pointer the findings must be sent in full');
});

test('a regeneration keeps the same prefix, which is the part a cache can reuse', async () => {
  const { prompt: first, document } = await promptFor();
  const { prompt: again } = await promptFor({ document, notes: [] });

  const tail = '\n\nWrite the engineering review for this story.';
  assert.ok(first.endsWith(tail), 'the first prompt ends with the instruction to write the review');
  const shared = first.slice(0, first.length - tail.length);

  assert.ok(shared.includes(FINDINGS_PATH), 'the shared prefix must reach as far as the findings pointer');
  assert.ok(again.startsWith(shared), 'a regeneration must not change a byte before the previous review');
  assert.ok(
    again.slice(shared.length).includes('Previous review'),
    'the only thing a regeneration adds is the previous review, and it goes last',
  );
});
