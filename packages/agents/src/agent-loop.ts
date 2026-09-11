import { createLogger, type Logger } from '@ai-engine/shared';
import type { AiProvider, GenerateRequest, ModelMessage, ToolDefinition } from '@ai-engine/ai-provider';
import { collectText, textMessage, toolResultMessage } from '@ai-engine/ai-provider';
import type { ToolContext, ToolRegistry } from '@ai-engine/tools';

export interface AgentLoopOptions {
  provider: AiProvider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  system: string;
  initialMessages: ModelMessage[];
  maxIterations: number;
  maxTokens?: number;
  temperature?: number;
  logger?: Logger;
  /** Called after each assistant turn, used for live progress in the UI. */
  onStep?: (step: { iteration: number; text: string; toolNames: string[] }) => Promise<void> | void;
}

export interface AgentLoopResult {
  finalText: string;
  messages: ModelMessage[];
  iterations: number;
  toolCallCount: number;
  /** The cache counts are always zero: the provider response carries none. */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  stoppedBecause: 'end_turn' | 'max_iterations' | 'max_tokens';
}

/**
 * The agentic loop: the model may only act through registered tools, and every
 * tool result is written back into the conversation. Nothing else touches the
 * system, so a crashed loop leaves no half-applied side effects beyond the
 * workspace, which is itself disposable.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const logger = options.logger ?? createLogger('agent-loop');
  const messages: ModelMessage[] = [...options.initialMessages];
  const definitions: ToolDefinition[] = options.registry
    .definitionsFor(options.toolContext.phase, options.toolContext.capabilities)
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

  let toolCallCount = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let finalText = '';

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    const request: GenerateRequest = {
      system: options.system,
      messages,
      tools: definitions,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    };
    const response = await options.provider.generate(request);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    finalText = response.text || finalText;

    const assistantBlocks = [
      ...(response.text ? [{ type: 'text' as const, text: response.text }] : []),
      ...response.toolCalls.map((call) => ({
        type: 'tool_use' as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ];
    if (assistantBlocks.length > 0) messages.push({ role: 'assistant', content: assistantBlocks });

    await options.onStep?.({
      iteration,
      text: response.text,
      toolNames: response.toolCalls.map((call) => call.name),
    });

    if (response.toolCalls.length === 0) {
      return { finalText, messages, iterations: iteration, toolCallCount, usage, stoppedBecause: response.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn' };
    }

    const results: { toolUseId: string; content: string; isError?: boolean }[] = [];
    for (const call of response.toolCalls) {
      toolCallCount++;
      logger.debug('tool call', { tool: call.name, iteration });
      const result = await options.registry.execute(call.name, call.input, options.toolContext);
      results.push({ toolUseId: call.id, content: result.output, isError: result.isError ?? false });
    }
    messages.push(toolResultMessage(results));
  }

  return { finalText, messages, iterations: options.maxIterations, toolCallCount, usage, stoppedBecause: 'max_iterations' };
}

/**
 * Runs the loop and then asks for one final structured answer, so tool use and
 * the machine readable result never fight for the same response.
 */
export async function runAgentLoopWithStructuredResult<T>(
  options: AgentLoopOptions & { resultInstruction: string; validate: (value: unknown) => T },
): Promise<{ loop: AgentLoopResult; result: T }> {
  const loop = await runAgentLoop(options);
  const messages = [...loop.messages, textMessage('user', options.resultInstruction)];
  const result = await options.provider.structuredOutput(
    { system: options.system, messages, maxTokens: options.maxTokens, temperature: 0 },
    options.validate,
  );
  return { loop, result };
}

export function conversationTranscript(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const toolUses = message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => (block.type === 'tool_use' ? `[tool ${block.name}] ${JSON.stringify(block.input).slice(0, 500)}` : ''))
        .join('\n');
      const toolResults = message.content
        .filter((block) => block.type === 'tool_result')
        .map((block) => (block.type === 'tool_result' ? `[result] ${block.content.slice(0, 1000)}` : ''))
        .join('\n');
      return [`### ${message.role}`, collectText(message.content), toolUses, toolResults].filter(Boolean).join('\n');
    })
    .join('\n\n');
}
