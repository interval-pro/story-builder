import { createLogger, newId, type Logger } from '@ai-engine/shared';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '@ai-engine/agents';
import { runClaudeCli } from './cli';
import { parseStructuredAnswer } from './structured-output';
import { resultTimeoutFor } from './timeouts';
import { answerPassPolicy, policyForPhase, type PhasePolicy } from './phase-policy';
import { mergeUsage, type PassUsage } from './usage';
import type { ClaudeResult, ClaudeStreamEvent } from './types';

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
  /**
   * Overrides the reasoning effort the phase would otherwise ask for. A small
   * change does not need the depth a large one does, and effort is the single
   * biggest lever on what a run costs.
   */
  effort?: PhasePolicy['effort'];
  /**
   * Lets the agent delegate to a subagent. Off unless the installation turns it
   * on; see AgentEngineConfig.allowSubagents for why, and for the one-at-a-time
   * limit that applies if it ever is.
   */
  allowSubagents?: boolean;
  /**
   * Directories outside the worktree the work pass may read, passed as
   * `--add-dir`. Used to hand an agent an artifact it would otherwise be sent
   * inline on every run.
   */
  additionalDirectories?: string[];
  /** Called for every tool the CLI uses, so the audit log stays complete. */
  onToolUse?: (use: { name: string; input: Record<string, unknown> }) => void | Promise<void>;
}



/** What one pass spent, in the shape the merge works on. */
function passUsage(result: ClaudeResult): PassUsage {
  return {
    usage: result.usage,
    costUsd: result.costUsd,
    modelUsage: result.modelUsage,
    subagentStats: result.subagentStats,
  };
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
    const basePolicy = policyForPhase(request.phase, { allowSubagents: this.options.allowSubagents ?? false });
    const policy: PhasePolicy = this.options.effort ? { ...basePolicy, effort: this.options.effort } : basePolicy;
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
      ...(this.options.additionalDirectories?.length ? { additionalDirectories: this.options.additionalDirectories } : {}),
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

    // Second pass: no tools, no edits, JSON only. It reads nothing, so it is
    // given no additional directory either.
    const answer = await runClaudeCli({
      cwd: this.options.workspacePath,
      prompt: request.resultInstruction,
      timeoutMs: resultTimeoutFor(this.options),
      resumeSessionId: work.sessionId,
      ...answerPassPolicy({ allowSubagents: this.options.allowSubagents ?? false }),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.binary ? { binary: this.options.binary } : {}),
    });

    const spend = mergeUsage(passUsage(work), passUsage(answer));

    return {
      result: request.validate(parseStructuredAnswer(answer.text)),
      transcript: work.transcript,
      toolCallCount: work.toolUses.length,
      usage: spend.usage,
      sessionId: work.sessionId,
      costUsd: spend.costUsd,
      modelUsage: spend.modelUsage,
      subagentStats: spend.subagentStats,
      permissionDenials: work.permissionDenials,
    };
  }
}
