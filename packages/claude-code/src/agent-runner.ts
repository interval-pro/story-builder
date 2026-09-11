import { createLogger, newId, type Logger } from '@ai-engine/shared';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '@ai-engine/agents';
import { runClaudeCli } from './cli';
import { parseStructuredAnswer } from './structured-output';
import { resultTimeoutFor } from './timeouts';
import { answerPassPolicy, policyForPhase, type PhasePolicy } from './phase-policy';
import { mergeUsage } from './usage';
import { passUsage, withWorkPassSpend } from './pass-failure';
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
  /**
   * What a chat session may do in the project directory. Only the CHAT phase
   * reads it; every other phase's permission mode follows from what that phase
   * is allowed to be, and is not the caller's to choose.
   */
  chatPermissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';
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
    const basePolicy = policyForPhase(request.phase, {
      allowSubagents: this.options.allowSubagents ?? false,
      ...(this.options.chatPermissionMode ? { chatPermissionMode: this.options.chatPermissionMode } : {}),
    });
    const policy: PhasePolicy = this.options.effort ? { ...basePolicy, effort: this.options.effort } : basePolicy;
    const sessionId = request.resumeSessionId ?? newId();
    let iteration = 0;

    // Before the process exists, not after it succeeds: a run that dies still
    // leaves behind the session a retry can continue.
    await request.onSessionStart?.(sessionId);

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
    // given no additional directory either. It carries the work pass's own
    // effort: changing the effort inside a session rebuilds the prompt cache
    // from scratch, and this pass resumes the session the work pass just filled.
    //
    // A failure here is re-thrown carrying both passes' usage. The work pass has
    // already happened and has usually spent almost everything the run will
    // spend; letting its numbers die with the answer pass is what made a run that
    // got all the way to the last step look free.
    const answer = await runClaudeCli({
      cwd: this.options.workspacePath,
      prompt: request.resultInstruction,
      timeoutMs: resultTimeoutFor(this.options),
      resumeSessionId: work.sessionId,
      ...answerPassPolicy({ allowSubagents: this.options.allowSubagents ?? false, effort: policy.effort }),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.binary ? { binary: this.options.binary } : {}),
    }).catch((error: unknown) => {
      throw withWorkPassSpend(error, work);
    });

    const spend = mergeUsage(passUsage(work), passUsage(answer));

    return {
      result: request.validate(parseStructuredAnswer(answer.text)),
      transcript: work.transcript,
      toolCallCount: work.toolUses.length,
      usage: spend.usage,
      sessionId: work.sessionId,
      resumed: Boolean(request.resumeSessionId),
      effort: policy.effort ?? null,
      model: this.options.model ?? null,
      costUsd: spend.costUsd,
      modelUsage: spend.modelUsage,
      subagentStats: spend.subagentStats,
      permissionDenials: work.permissionDenials,
    };
  }
}

