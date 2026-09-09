import { AppError, createLogger, extractJson, loadConfig, retry, TimeoutError, withTimeout } from '@ai-engine/shared';
import type { AiProvider, ContentBlock, GenerateRequest, GenerateResponse, ModelMessage } from '../types';

const logger = createLogger('openai-provider');
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toOpenAiMessages(messages: ModelMessage[], system?: string): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];
  if (system) result.push({ role: 'system', content: system });
  for (const message of messages) {
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result');
    const toolUses = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use');
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    if (toolResults.length > 0) {
      for (const result_ of toolResults) {
        result.push({ role: 'tool', content: result_.content, tool_call_id: result_.toolUseId });
      }
      if (text.trim()) result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text });
      continue;
    }

    if (toolUses.length > 0) {
      result.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: 'function' as const,
          function: { name: use.name, arguments: JSON.stringify(use.input) },
        })),
      });
      continue;
    }

    result.push({ role: message.role, content: text });
  }
  return result;
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly timeoutMs: number = loadConfig().ai.requestTimeoutMs,
  ) {}

  private buildBody(request: GenerateRequest, stream: boolean): Record<string, unknown> {
    const config = loadConfig();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(request.messages, request.system),
      max_completion_tokens: request.maxTokens ?? config.ai.maxOutputTokens,
      temperature: request.temperature ?? config.ai.temperature,
      stream,
    };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }
    if (request.jsonMode) body['response_format'] = { type: 'json_object' };
    return body;
  }

  private async call(body: Record<string, unknown>): Promise<Response> {
    return retry(
      async () => {
        const response = await withTimeout(
          fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
          }),
          this.timeoutMs,
          () => new TimeoutError('openai request', this.timeoutMs),
        );
        if (response.status === 429 || response.status >= 500) {
          throw new AppError('provider_unavailable', `OpenAI responded with ${response.status}`, 503);
        }
        return response;
      },
      { attempts: 3, baseMs: 1000, onError: (error, attempt) => logger.warn('openai retry', { attempt, error }) },
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await this.call(this.buildBody(request, false));
    if (!response.ok) {
      const text = await response.text();
      throw new AppError('provider_error', `OpenAI request failed: ${response.status} ${text}`, 502);
    }
    const data = (await response.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const choice = data.choices[0];
    const toolCalls = (choice?.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      input: call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {},
    }));
    const finish = choice?.finish_reason ?? 'stop';
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      stopReason: finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      raw: data,
    };
  }

  async stream(request: GenerateRequest, onDelta: (chunk: string) => void): Promise<GenerateResponse> {
    const response = await this.call(this.buildBody(request, true));
    if (!response.ok || !response.body) {
      const text = response.ok ? 'empty body' : await response.text();
      throw new AppError('provider_error', `OpenAI stream failed: ${response.status} ${text}`, 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let stopReason: GenerateResponse['stopReason'] = 'end_turn';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice('data: '.length).trim();
        if (payload === '[DONE]') continue;
        const event = JSON.parse(payload) as Record<string, any>;
        const delta = event['choices']?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          onDelta(delta.content as string);
        }
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index as number;
          const existing = toolCalls.get(index) ?? { id: call.id ?? '', name: '', arguments: '' };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) existing.arguments += call.function.arguments;
          toolCalls.set(index, existing);
        }
        const finish = event['choices']?.[0]?.finish_reason;
        if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'length') stopReason = 'max_tokens';
      }
    }

    return {
      text,
      toolCalls: [...toolCalls.values()].map((call) => ({
        id: call.id,
        name: call.name,
        input: call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {},
      })),
      stopReason,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async structuredOutput<T>(request: GenerateRequest, validate: (value: unknown) => T): Promise<T> {
    const response = await this.generate({ ...request, jsonMode: true });
    const json = extractJson(response.text);
    if (!json) {
      throw new AppError('structured_output_failed', 'The model did not return parseable JSON', 502, {
        preview: response.text.slice(0, 500),
      });
    }
    return validate(JSON.parse(json));
  }
}
