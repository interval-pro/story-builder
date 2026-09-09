import { PermissionDeniedError, TimeoutError, truncate, withTimeout } from '@ai-engine/shared';
import type { Capability, ExecutionPhase } from '@ai-engine/domain';
import { redact } from '@ai-engine/security';
import type { ToolContext, ToolResult, ToolSpec } from './types';

export interface ToolAuditRecord {
  toolName: string;
  input: Record<string, unknown>;
  status: 'OK' | 'ERROR' | 'DENIED';
  summary: string;
  durationMs: number;
  artifactId?: string | null;
}

export type ToolAuditSink = (record: ToolAuditRecord) => Promise<void>;

/**
 * Single entry point for every agent action. Enforces capabilities, phase
 * restrictions, input validation, timeouts, output limits and audit logging.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec<any>>();

  constructor(tools: ToolSpec<any>[] = [], private readonly audit?: ToolAuditSink) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: ToolSpec<any>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolSpec<any> | undefined {
    return this.tools.get(name);
  }

  /** Tools the agent may see, given its phase and granted capabilities. */
  availableFor(phase: ExecutionPhase, capabilities: readonly Capability[]): ToolSpec<any>[] {
    return [...this.tools.values()].filter(
      (tool) => tool.phases.includes(phase) && capabilities.includes(tool.capability),
    );
  }

  definitionsFor(phase: ExecutionPhase, capabilities: readonly Capability[]): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[] {
    return this.availableFor(phase, capabilities).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(name: string, rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      const result: ToolResult = { output: `Unknown tool: ${name}`, summary: `unknown tool ${name}`, isError: true };
      await this.record(name, rawInput, 'ERROR', result, Date.now() - started);
      return result;
    }

    try {
      if (!tool.phases.includes(context.phase)) {
        throw new PermissionDeniedError(`Tool ${name} cannot be used during the ${context.phase} phase`, {
          tool: name,
          phase: context.phase,
        });
      }
      if (!context.capabilities.includes(tool.capability)) {
        throw new PermissionDeniedError(`Tool ${name} requires the ${tool.capability} capability`, {
          tool: name,
          capability: tool.capability,
        });
      }

      const input = tool.validate(rawInput);
      const raw = await withTimeout(
        tool.execute(input, context),
        tool.timeoutMs,
        () => new TimeoutError(`tool ${name}`, tool.timeoutMs),
      );

      const redacted = redact(raw.output, context.secretValues);
      const limited = truncate(redacted.text, tool.maxOutputChars);
      const result: ToolResult = {
        ...raw,
        output: limited.text,
        metadata: {
          ...raw.metadata,
          truncated: limited.truncated,
          originalLength: limited.originalLength,
          redactions: redacted.redactions,
        },
      };
      await this.record(name, rawInput, raw.isError ? 'ERROR' : 'OK', result, Date.now() - started);
      return result;
    } catch (error) {
      const denied = error instanceof PermissionDeniedError;
      const message = error instanceof Error ? error.message : String(error);
      const result: ToolResult = {
        output: denied ? `Denied: ${message}` : `Tool error: ${message}`,
        summary: message.slice(0, 200),
        isError: true,
      };
      await this.record(name, rawInput, denied ? 'DENIED' : 'ERROR', result, Date.now() - started);
      return result;
    }
  }

  private async record(
    toolName: string,
    input: Record<string, unknown>,
    status: ToolAuditRecord['status'],
    result: ToolResult,
    durationMs: number,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit({
      toolName,
      input,
      status,
      summary: result.summary,
      durationMs,
      artifactId: result.artifactId ?? null,
    });
  }
}
