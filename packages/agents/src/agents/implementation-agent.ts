import { textMessage, type AiProvider } from '@ai-engine/ai-provider';
import type { QaFinding, ReviewDocument, RuntimeManifestDocument, Story, StoryRevision, Task } from '@ai-engine/domain';
import { renderReviewMarkdown } from '@ai-engine/domain';
import type { ToolContext, ToolRegistry } from '@ai-engine/tools';
import type { Logger } from '@ai-engine/shared';
import { runAgentLoopWithStructuredResult, type AgentLoopResult } from '../agent-loop';
import { renderProjectContext, renderStoryContext, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateImplementationOutcome, type ImplementationOutcome } from '../schemas';

export interface ImplementationAgentInput {
  provider: AiProvider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  projectContext: ProjectContext;
  story: Story;
  revision: StoryRevision;
  task: Task;
  approvedReview: ReviewDocument;
  runtimeManifest: RuntimeManifestDocument | null;
  projectRoot: string;
  /** Set when this run is a fix cycle rather than the first implementation. */
  qaFindings?: QaFinding[];
  qaIteration?: number;
  maxIterations?: number;
  logger?: Logger;
  onStep?: (step: { iteration: number; text: string; toolNames: string[] }) => Promise<void> | void;
}

const RESULT_INSTRUCTION = `Now report what you actually did, as a single JSON object with exactly this shape:

{
  "summary": "string, what you implemented and how you verified it",
  "changedFiles": ["path"],
  "deviations": [{ "planned": "string", "actual": "string", "reason": "string" }],
  "testsAdded": ["path or test name"],
  "testsModified": ["path or test name"],
  "testsRemoved": ["path or test name"],
  "testJustification": "string, why any existing test was changed or removed",
  "discoveredIssues": [{ "title": "string", "detail": "string", "requiresSupplementalReview": false }],
  "impactedResources": [{ "kind": "file | symbol | module | database_table | database_column | migration | api | event | contract", "identifier": "string", "access": "read | write" }]
}

Be honest. If the build or the tests do not pass, say so in the summary rather than claiming success.
Return only the JSON object.`;

function renderRuntimeCommands(manifest: RuntimeManifestDocument | null): string {
  if (!manifest) return 'No runtime manifest is available. Discover the build and test commands yourself.';
  return [
    'Use these project commands:',
    `- setup: ${manifest.setup.commands.join(' && ') || 'none'}`,
    `- build: ${manifest.build.commands.join(' && ') || 'none'}`,
    `- test: ${manifest.test.commands.join(' && ') || 'none'}`,
    `- lint: ${manifest.lint.commands.join(' && ') || 'none'}`,
    `- migrate: ${manifest.database.migrate.join(' && ') || 'none'}`,
  ].join('\n');
}

/** Executes the approved plan inside the task sandbox. */
export async function runImplementationAgent(
  input: ImplementationAgentInput,
): Promise<{ outcome: ImplementationOutcome; loop: AgentLoopResult }> {
  const instructions = await loadAgentPrompt('implementation', input.projectRoot);
  const system = [
    instructions,
    '',
    renderProjectContext(input.projectContext),
    '',
    '## Workspace',
    '',
    'You are working in an isolated writable Git worktree of this repository. Changes here never',
    'touch the developer working copy and are never pushed without a separate human approval.',
    '',
    renderRuntimeCommands(input.runtimeManifest),
  ].join('\n');

  const userParts = [
    renderStoryContext(input.story, input.revision, input.task),
    '',
    '## Approved engineering review',
    '',
    'This is the intent the human approved. It is the contract for this task.',
    '',
    renderReviewMarkdown(input.approvedReview),
  ];

  if (input.qaFindings && input.qaFindings.length > 0) {
    userParts.push(
      '',
      '---',
      '',
      `## QA findings to fix (iteration ${input.qaIteration ?? 1})`,
      '',
      input.qaFindings
        .map(
          (finding, index) =>
            [
              `${index + 1}. [${finding.severity}/${finding.category}] ${finding.summary}`,
              finding.file ? `   file: ${finding.file}` : '',
              `   detail: ${finding.detail}`,
              finding.suggestedFix ? `   suggested fix: ${finding.suggestedFix}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
        )
        .join('\n\n'),
      '',
      'Fix these findings without widening the approved scope. Re-run the build and the tests afterwards.',
    );
  } else {
    userParts.push('', 'Implement the approved plan, then run the build and the test suite.');
  }

  const { loop, result } = await runAgentLoopWithStructuredResult({
    provider: input.provider,
    registry: input.registry,
    toolContext: input.toolContext,
    system,
    initialMessages: [textMessage('user', userParts.join('\n'))],
    maxIterations: input.maxIterations ?? 60,
    logger: input.logger,
    onStep: input.onStep,
    resultInstruction: RESULT_INSTRUCTION,
    validate: validateImplementationOutcome,
  });

  return { outcome: result, loop };
}
