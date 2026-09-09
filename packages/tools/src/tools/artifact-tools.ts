import type { ToolResult, ToolSpec } from '../types';
import { optionalString, requireString } from '../types';

const ALL_PHASES = ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const;

export const artifactWriteTool: ToolSpec<{ kind: string; content: string; contentType?: string }> = {
  name: 'artifact_write',
  description: 'Store a long note, report or log outside the model context so it survives the run and can be read later.',
  capability: 'artifact.write',
  phases: [...ALL_PHASES],
  timeoutMs: 20_000,
  maxOutputChars: 2000,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'Artifact kind, for example research_notes or qa_report' },
      content: { type: 'string' },
      contentType: { type: 'string' },
    },
    required: ['kind', 'content'],
  },
  validate(input) {
    return {
      kind: requireString(input, 'kind'),
      content: requireString(input, 'content'),
      contentType: optionalString(input, 'contentType'),
    };
  },
  async execute(input, context): Promise<ToolResult> {
    const artifact = await context.artifacts.put({
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      kind: input.kind,
      contentType: input.contentType ?? 'text/markdown',
      content: input.content,
    });
    return {
      output: `Stored artifact ${artifact.id} (${artifact.sizeBytes} bytes).`,
      summary: `stored ${input.kind} artifact`,
      artifactId: artifact.id,
    };
  },
};

export const artifactReadTool: ToolSpec<{ id: string }> = {
  name: 'artifact_read',
  description: 'Read back an artifact that was stored earlier in this task.',
  capability: 'artifact.read',
  phases: [...ALL_PHASES],
  timeoutMs: 20_000,
  maxOutputChars: 60_000,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  validate(input) {
    return { id: requireString(input, 'id') };
  },
  async execute(input, context): Promise<ToolResult> {
    const { record, content } = await context.artifacts.get(input.id);
    if (record.taskId && record.taskId !== context.taskId) {
      return { output: 'That artifact belongs to a different task.', summary: 'artifact access denied', isError: true };
    }
    return {
      output: content.toString('utf8'),
      summary: `read artifact ${record.kind}`,
      metadata: { kind: record.kind, sizeBytes: record.sizeBytes },
    };
  },
};
