import { textMessage, type AiProvider } from '@ai-engine/ai-provider';
import type { ExecutionPhase } from '@ai-engine/domain';
import type { Logger } from '@ai-engine/shared';
import type { ToolContext, ToolRegistry } from '@ai-engine/tools';
import { conversationTranscript, runAgentLoopWithStructuredResult } from './agent-loop';
import type { AgentType } from './prompts/prompt-loader';

export interface AgentStep {
  iteration: number;
  text: string;
  toolNames: string[];
}

export interface AgentRunRequest<T> {
  phase: ExecutionPhase;
  agentType: AgentType;
  system: string;
  prompt: string;
  /** Asks for the machine readable result once the work itself is done. */
  resultInstruction: string;
  validate: (value: unknown) => T;
  maxIterations?: number;
  /** Continues an earlier conversation. The fix loop uses this. */
  resumeSessionId?: string;
  onStep?: (step: AgentStep) => void | Promise<void>;
}

export interface AgentRunOutcome<T> {
  result: T;
  transcript: string;
  toolCallCount: number;
  /**
   * Cache reads are kept beside the input count rather than folded into it.
   * They bill at roughly a tenth of input, so one combined number would look
   * plausible and be wrong, and input alone is a few dozen tokens on a resumed
   * session whatever the prompt actually cost.
   */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  /** Set by engines that keep a resumable conversation. */
  sessionId: string | null;
  costUsd: number | null;
  /** Per-model token counts when the engine reports them, otherwise null. */
  modelUsage: Record<string, unknown> | null;
  /** The only direct evidence of a phase that still delegated. Null if unknown. */
  subagentStats: Record<string, unknown> | null;
  /** Actions the engine refused. Anything here is worth a human's attention. */
  permissionDenials: unknown[];
}

/**
 * The execution engine behind an agent. The pipeline, the gates and the
 * verification do not care which one is used; they only care about the
 * structured result and the diff it leaves behind.
 */
export interface AgentRunner {
  readonly kind: string;
  run<T>(request: AgentRunRequest<T>): Promise<AgentRunOutcome<T>>;
}

export interface BuiltinRunnerOptions {
  provider: AiProvider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  logger?: Logger;
}

/**
 * The in-process loop: the model may only act through the registered tools, and
 * every call is audited by the tool layer.
 */
export class BuiltinAgentRunner implements AgentRunner {
  readonly kind = 'builtin';

  constructor(private readonly options: BuiltinRunnerOptions) {}

  async run<T>(request: AgentRunRequest<T>): Promise<AgentRunOutcome<T>> {
    const { loop, result } = await runAgentLoopWithStructuredResult({
      provider: this.options.provider,
      registry: this.options.registry,
      toolContext: this.options.toolContext,
      system: request.system,
      initialMessages: [textMessage('user', request.prompt)],
      maxIterations: request.maxIterations ?? 30,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      ...(request.onStep ? { onStep: request.onStep } : {}),
      resultInstruction: request.resultInstruction,
      validate: request.validate,
    });

    return {
      result,
      transcript: conversationTranscript(loop.messages),
      toolCallCount: loop.toolCallCount,
      usage: loop.usage,
      sessionId: null,
      // The provider reports neither a cost nor a per-model breakdown, and this
      // engine has no delegation tool to report on.
      costUsd: null,
      modelUsage: null,
      subagentStats: null,
      permissionDenials: [],
    };
  }
}
