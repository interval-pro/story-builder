import { AppError, extractJson } from '@ai-engine/shared';
import type { AiProvider, GenerateRequest, GenerateResponse } from '../types';

export type MockHandler = (request: GenerateRequest) => GenerateResponse | string;

function response(text: string): GenerateResponse {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Deterministic provider used by tests and by installations that have no API
 * key yet. It answers with structurally valid documents so the whole lifecycle
 * can be exercised offline.
 */
export class MockProvider implements AiProvider {
  readonly name = 'mock';
  private readonly queue: (GenerateResponse | string)[] = [];
  public readonly requests: GenerateRequest[] = [];

  constructor(readonly model = 'mock-model', private handler: MockHandler = defaultHandler) {}

  /** Queues one scripted answer, consumed before the handler is used. */
  enqueue(...responses: (GenerateResponse | string)[]): void {
    this.queue.push(...responses);
  }

  setHandler(handler: MockHandler): void {
    this.handler = handler;
  }

  private next(request: GenerateRequest): GenerateResponse {
    const queued = this.queue.shift();
    const value = queued ?? this.handler(request);
    return typeof value === 'string' ? response(value) : value;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push(request);
    return this.next(request);
  }

  async stream(request: GenerateRequest, onDelta: (chunk: string) => void): Promise<GenerateResponse> {
    const result = await this.generate(request);
    for (const chunk of result.text.match(/.{1,40}/gs) ?? []) onDelta(chunk);
    return result;
  }

  async structuredOutput<T>(request: GenerateRequest, validate: (value: unknown) => T): Promise<T> {
    const result = await this.generate(request);
    const json = extractJson(result.text);
    if (!json) {
      throw new AppError('structured_output_failed', 'Mock provider returned no JSON', 502, {
        preview: result.text.slice(0, 300),
      });
    }
    return validate(JSON.parse(json));
  }
}

function lastUserText(request: GenerateRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : ''))
      .join('\n');
    if (text.trim()) return text;
  }
  return '';
}

/** Recognises which agent is calling from the shape of its system prompt. */
function defaultHandler(request: GenerateRequest): GenerateResponse | string {
  const system = (request.system ?? '').toLowerCase();
  const prompt = lastUserText(request).slice(0, 400);

  if (system.includes('research agent')) {
    return JSON.stringify({
      summary: 'Mock research summary produced without a model provider.',
      relevantFiles: [],
      relevantSymbols: [],
      executionPaths: [],
      databaseNotes: [],
      testNotes: [],
      dependencyNotes: [],
      externalFindings: [],
      openQuestions: ['No AI provider is configured, so this analysis is a placeholder.'],
      riskSignals: [],
    });
  }

  if (system.includes('engineering review agent')) {
    return JSON.stringify({
      summary: `Mock engineering review for: ${prompt.slice(0, 120)}`,
      sections: {
        story_understanding: prompt.slice(0, 400) || 'Story understanding placeholder.',
        current_system_behavior: 'No AI provider is configured, so no real analysis was performed.',
        recommended_approach: 'Configure an AI provider and regenerate this review.',
        why_this_approach: 'A real provider is required for a meaningful recommendation.',
        downsides_tradeoffs: 'This placeholder review carries no engineering judgement.',
        risks: 'Acting on a placeholder review is itself the main risk.',
        testing_strategy: 'Run the existing project test suite.',
        implementation_plan: 'Configure AI_PROVIDER and AI_API_KEY, then regenerate.',
        expected_changed_files: 'Unknown until a real analysis runs.',
      },
      implementationSteps: [
        { order: 1, title: 'Configure an AI provider', detail: 'Set AI_PROVIDER and AI_API_KEY, then regenerate the review.', files: [] },
      ],
      expectedFiles: [],
      expectedSymbols: [],
      riskSignals: [],
      openQuestions: [],
    });
  }

  if (system.includes('qa agent')) {
    return JSON.stringify({
      verdict: 'APPROVED',
      summary: 'Mock QA run: no provider configured, no findings produced.',
      findings: [],
    });
  }

  if (system.includes('learning agent')) {
    return JSON.stringify({ principles: [], invariants: [] });
  }

  if (system.includes('implementation agent')) {
    return 'No AI provider is configured, so no code changes were made.';
  }

  return JSON.stringify({ result: 'mock', prompt: prompt.slice(0, 200) });
}
