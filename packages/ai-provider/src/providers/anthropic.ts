import { AppError, createLogger, loadConfig, retry, withTimeout, TimeoutError, extractJson } from '@ai-engine/shared';
import type { AiProvider, ContentBlock, GenerateRequest, GenerateResponse, ModelMessage } from '../types';

const logger = createLogger('anthropic-provider');
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function toAnthropicContent(blocks: ContentBlock[]): unknown[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError ?? false,
        };
    }
  });
}

function toAnthropicMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => ({ role: message.role, content: toAnthropicContent(message.content) }));
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

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
      max_tokens: request.maxTokens ?? config.ai.maxOutputTokens,
      temperature: request.temperature ?? config.ai.temperature,
      messages: toAnthropicMessages(request.messages),
      stream,
    };
    if (request.system) body['system'] = request.system;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    return body;
  }

  private async call(body: Record<string, unknown>): Promise<Response> {
    return retry(
      async () => {
        const response = await withTimeout(
          fetch(`${this.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': this.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
          }),
          this.timeoutMs,
          () => new TimeoutError('anthropic request', this.timeoutMs),
        );
        if (response.status === 429 || response.status >= 500) {
          throw new AppError('provider_unavailable', `Anthropic responded with ${response.status}`, 503);
        }
        return response;
      },
      { attempts: 3, baseMs: 1000, onError: (error, attempt) => logger.warn('anthropic retry', { attempt, error }) },
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await this.call(this.buildBody(request, false));
    if (!response.ok) {
      const text = await response.text();
      throw new AppError('provider_error', `Anthropic request failed: ${response.status} ${text}`, 502);
    }
    const data = (await response.json()) as AnthropicResponse;
    const textParts: string[] = [];
    const toolCalls: GenerateResponse['toolCalls'] = [];
    for (const block of data.content) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
      if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
    return {
      text: textParts.join('\n'),
      toolCalls,
      stopReason: (data.stop_reason as GenerateResponse['stopReason']) ?? 'end_turn',
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      raw: data,
    };
  }

  async stream(request: GenerateRequest, onDelta: (chunk: string) => void): Promise<GenerateResponse> {
    const response = await this.call(this.buildBody(request, true));
    if (!response.ok || !response.body) {
      const text = response.ok ? 'empty body' : await response.text();
      throw new AppError('provider_error', `Anthropic stream failed: ${response.status} ${text}`, 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls: GenerateResponse['toolCalls'] = [];
    const partialToolInputs = new Map<number, { id: string; name: string; json: string }>();
    let usage = { inputTokens: 0, outputTokens: 0 };
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
        if (event['type'] === 'content_block_start' && event['content_block']?.type === 'tool_use') {
          partialToolInputs.set(event['index'] as number, {
            id: event['content_block'].id as string,
            name: event['content_block'].name as string,
            json: '',
          });
        } else if (event['type'] === 'content_block_delta') {
          const delta = event['delta'];
          if (delta?.type === 'text_delta') {
            text += delta.text;
            onDelta(delta.text as string);
          } else if (delta?.type === 'input_json_delta') {
            const partial = partialToolInputs.get(event['index'] as number);
            if (partial) partial.json += delta.partial_json;
          }
        } else if (event['type'] === 'message_delta') {
          if (event['delta']?.stop_reason) stopReason = event['delta'].stop_reason;
          if (event['usage']?.output_tokens) usage.outputTokens = event['usage'].output_tokens;
        } else if (event['type'] === 'message_start') {
          usage.inputTokens = event['message']?.usage?.input_tokens ?? 0;
        }
      }
    }

    for (const partial of partialToolInputs.values()) {
      toolCalls.push({
        id: partial.id,
        name: partial.name,
        input: partial.json ? (JSON.parse(partial.json) as Record<string, unknown>) : {},
      });
    }
    return { text, toolCalls, stopReason, usage };
  }

  async structuredOutput<T>(request: GenerateRequest, validate: (value: unknown) => T): Promise<T> {
    const response = await this.generate({
      ...request,
      system: `${request.system ?? ''}\n\nRespond with a single JSON object and nothing else.`.trim(),
    });
    const json = extractJson(response.text);
    if (!json) {
      throw new AppError('structured_output_failed', 'The model did not return parseable JSON', 502, {
        preview: response.text.slice(0, 500),
      });
    }
    return validate(JSON.parse(json));
  }
}
