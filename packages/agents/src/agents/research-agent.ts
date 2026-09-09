import { textMessage, type AiProvider } from '@ai-engine/ai-provider';
import type { Story, StoryRevision, Task } from '@ai-engine/domain';
import type { ToolContext, ToolRegistry } from '@ai-engine/tools';
import type { Logger } from '@ai-engine/shared';
import { runAgentLoopWithStructuredResult, type AgentLoopResult } from '../agent-loop';
import { renderProjectContext, renderStoryContext, type ProjectContext } from '../context';
import { loadAgentPrompt } from '../prompts/prompt-loader';
import { validateResearchFindings, type ResearchFindings } from '../schemas';

export interface ResearchAgentInput {
  provider: AiProvider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  projectContext: ProjectContext;
  story: Story;
  revision: StoryRevision;
  task: Task;
  projectRoot: string;
  maxIterations?: number;
  logger?: Logger;
  onStep?: (step: { iteration: number; text: string; toolNames: string[] }) => Promise<void> | void;
}

const RESULT_INSTRUCTION = `Now produce your findings as a single JSON object with exactly this shape:

{
  "summary": "string, what you established about the story and the system",
  "relevantFiles": [{ "path": "string", "why": "string" }],
  "relevantSymbols": [{ "name": "string", "path": "string", "why": "string" }],
  "executionPaths": ["string, one end to end path per entry"],
  "databaseNotes": ["string"],
  "testNotes": ["string, including what is not covered"],
  "dependencyNotes": ["string"],
  "externalFindings": [{ "source": "string", "trustTier": 1, "claim": "string", "validation": "how you validated it against this repository" }],
  "openQuestions": ["string, anything you could not establish"],
  "riskSignals": [{ "indicator": "one of database_migration, destructive_operation, authentication, security, core_shared_module, public_api_change, large_blast_radius, deployment_change, data_transformation, weak_test_coverage", "evidence": "string" }]
}

Return only the JSON object.`;

/** Read-only repository research. The first stage of every task. */
export async function runResearchAgent(
  input: ResearchAgentInput,
): Promise<{ findings: ResearchFindings; loop: AgentLoopResult }> {
  const instructions = await loadAgentPrompt('research', input.projectRoot);
  const system = [
    instructions,
    '',
    renderProjectContext(input.projectContext),
    '',
    '## Workspace',
    '',
    'You are working in an isolated read-only checkout of the repository at the task base commit.',
    'Use the tools to inspect it. Never claim behaviour you have not read.',
  ].join('\n');

  const { loop, result } = await runAgentLoopWithStructuredResult({
    provider: input.provider,
    registry: input.registry,
    toolContext: input.toolContext,
    system,
    initialMessages: [
      textMessage(
        'user',
        [
          renderStoryContext(input.story, input.revision, input.task),
          '',
          'Research this story against the repository. Work through the code until you can explain',
          'the current behaviour end to end, then report what you found.',
        ].join('\n'),
      ),
    ],
    maxIterations: input.maxIterations ?? 40,
    logger: input.logger,
    onStep: input.onStep,
    resultInstruction: RESULT_INSTRUCTION,
    validate: validateResearchFindings,
  });

  return { findings: result, loop };
}

/** Renders findings for the review agent prompt. */
export function renderResearchFindings(findings: ResearchFindings): string {
  const section = (title: string, body: string) => (body.trim() ? `### ${title}\n\n${body}\n` : '');
  const list = (entries: string[]) => entries.map((entry) => `- ${entry}`).join('\n');

  return [
    `## Research findings\n\n${findings.summary}\n`,
    section('Relevant files', findings.relevantFiles.map((file) => `- ${file.path}: ${file.why}`).join('\n')),
    section('Relevant symbols', findings.relevantSymbols.map((symbol) => `- ${symbol.name} (${symbol.path}): ${symbol.why}`).join('\n')),
    section('Execution paths', list(findings.executionPaths)),
    section('Database', list(findings.databaseNotes)),
    section('Tests', list(findings.testNotes)),
    section('Dependencies', list(findings.dependencyNotes)),
    section(
      'External findings',
      findings.externalFindings
        .map((finding) => `- [tier ${finding.trustTier}] ${finding.source}: ${finding.claim}\n  validated by: ${finding.validation}`)
        .join('\n'),
    ),
    section('Open questions', list(findings.openQuestions)),
    section('Risk signals', findings.riskSignals.map((signal) => `- ${signal.indicator}: ${signal.evidence}`).join('\n')),
  ]
    .filter(Boolean)
    .join('\n');
}
