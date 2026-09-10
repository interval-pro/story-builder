import { createLogger, newId, type Logger } from '@ai-engine/shared';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '@ai-engine/agents';
import { runClaudeCli } from './cli';
import { parseStructuredAnswer } from './structured-output';
import { resultTimeoutFor } from './timeouts';
import { policyForPhase } from './phase-policy';
import type { ClaudeStreamEvent } from './types';

const logger = createLogger('claude-code-runner');

export interface ClaudeCodeRunnerOptions {
  /** The task worktree. The CLI never sees anything outside it. */
  workspacePath: string;
  model?: string;
  binary?: string;
  timeoutMs: number;
  logger?: Logger;
  /** Budget for the pass that writes the answer. Defaults to timeoutMs. */
  resultTimeoutMs?: number;
  /** Called for every tool the CLI uses, so the audit log stays complete. */
  onToolUse?: (use: { name: string; input: Record<string, unknown> }) => void | Promise<void>;
}



/**
 * Runs each agent as a headless Claude Code session inside the task worktree.
 * The work happens in one session; the machine readable result is asked for in
 * a second, resumed call with every tool switched off, so a tool call can never
 * be mistaken for the answer.
 */
export class ClaudeCodeAgentRunner implements AgentRunner {
  readonly kind = 'claude-code';

  constructor(private readonly options: ClaudeCodeRunnerOptions) {}

  async run<T>(request: AgentRunRequest<T>): Promise<AgentRunOutcome<T>> {
    const policy = policyForPhase(request.phase);
    const sessionId = request.resumeSessionId ?? newId();
    let iteration = 0;

    const work = await runClaudeCli({
      cwd: this.options.workspacePath,
      prompt: request.prompt,
      appendSystemPrompt: request.system,
      timeoutMs: this.options.timeoutMs,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.binary ? { binary: this.options.binary } : {}),
      ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : { sessionId }),
      ...policy,
      onEvent: async (event: ClaudeStreamEvent) => {
        const blocks = event.message?.content ?? [];
        const toolNames: string[] = [];
        let text = '';
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            toolNames.push(block.name);
            await this.options.onToolUse?.({ name: block.name, input: block.input ?? {} });
          }
          if (block.type === 'text' && block.text) text += block.text;
        }
        if (event.type === 'assistant') {
          iteration++;
          await request.onStep?.({ iteration, text, toolNames });
        }
      },
    });

    if (work.permissionDenials.length > 0) {
      logger.warn('the agent attempted actions it is not allowed to take', {
        phase: request.phase,
        denials: work.permissionDenials.length,
      });
    }

    // Second pass: no tools, no edits, JSON only.
    const answer = await runClaudeCli({
      cwd: this.options.workspacePath,
      prompt: request.resultInstruction,
      timeoutMs: resultTimeoutFor(this.options),
      resumeSessionId: work.sessionId,
      restricted: true,
      permissionMode: 'dontAsk',
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.binary ? { binary: this.options.binary } : {}),
    });

    return {
      result: request.validate(parseStructuredAnswer(answer.text)),
      transcript: work.transcript,
      toolCallCount: work.toolUses.length,
      usage: {
        inputTokens: work.usage.inputTokens + answer.usage.inputTokens,
        outputTokens: work.usage.outputTokens + answer.usage.outputTokens,
      },
      sessionId: work.sessionId,
      costUsd: work.costUsd + answer.costUsd,
      permissionDenials: work.permissionDenials,
    };
  }
}
