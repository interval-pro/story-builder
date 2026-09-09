export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface GenerateRequest {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Forces the model to answer with JSON only. */
  jsonMode?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResponse {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
  usage: TokenUsage;
  raw?: unknown;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest, onDelta: (chunk: string) => void): Promise<GenerateResponse>;
  structuredOutput<T>(request: GenerateRequest, validate: (value: unknown) => T): Promise<T>;
}

export function textMessage(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: [{ type: 'text', text }] };
}

export function toolResultMessage(results: { toolUseId: string; content: string; isError?: boolean }[]): ModelMessage {
  return {
    role: 'user',
    content: results.map((result) => ({
      type: 'tool_result' as const,
      toolUseId: result.toolUseId,
      content: result.content,
      isError: result.isError ?? false,
    })),
  };
}

export function collectText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
