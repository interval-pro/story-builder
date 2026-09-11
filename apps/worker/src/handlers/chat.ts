import { loadConfig, newId } from '@ai-engine/shared';
import { policyForPhase, runClaudeCli, type ClaudeStreamEvent } from '@ai-engine/claude-code';
import type { ProjectJobContext } from '../project-context';
import { failRunSpend, runCompletion } from '../job-context';

/**
 * How often the partially written answer is flushed to the database.
 *
 * The cockpit polls, so the transcript is only as live as these writes. Every
 * token would be a write per token; a second would make a long answer look
 * stalled. Half a second reads as typing.
 */
const FLUSH_INTERVAL_MS = 500;

/** The answer, as the person reads it: the prose, with the tools named inline. */
function renderTranscript(parts: { kind: 'text' | 'tool'; value: string }[]): string {
  return parts
    .map((part) => (part.kind === 'text' ? part.value : `\n\`${part.value}\`\n`))
    .join('')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * One turn of the chat window.
 *
 * This is the one place the engine is driven turn by turn by a person rather than
 * by the pipeline, and it is deliberately the widest: the window exists to be the
 * terminal they would otherwise open in the project directory, and a narrower
 * version of that is a different, less useful thing.
 *
 * It does not use the two-pass agent runner. That runner exists to get a
 * structured answer out of an agent; a chat answer is prose, and asking for JSON
 * afterwards would double the cost of every message for nothing.
 */
export async function handleChatTurn(context: ProjectJobContext): Promise<void> {
  const sessionId = String(context.job.payload['sessionId'] ?? '');
  const messageId = String(context.job.payload['messageId'] ?? '');
  const prompt = String(context.job.payload['prompt'] ?? '');
  if (!sessionId || !messageId || !prompt) {
    throw new Error(`Chat job ${context.job.id} is missing its session, message or prompt`);
  }

  const session = await context.repos.chat.getSession(sessionId);
  const config = loadConfig();

  if (config.agents.engine !== 'claude-code') {
    await context.repos.chat.updateMessage(messageId, {
      status: 'FAILED',
      error: 'The chat window needs the Claude Code engine. This installation is configured for the built-in loop.',
    });
    return;
  }

  // A session the engine has never seen needs an id we choose, so the next turn
  // has something to resume. After that the engine's own id wins.
  const engineSessionId = session.engineSessionId ?? newId();
  const resuming = Boolean(session.engineSessionId);

  const run = await context.repos.runs.start({
    projectId: context.project.id,
    kind: 'CHAT',
    subjectId: sessionId,
    phase: 'CHAT',
    agentType: 'chat',
    sessionId: engineSessionId,
    resumed: resuming,
  });
  await context.repos.chat.updateMessage(messageId, { status: 'STREAMING', runId: run.id });

  const parts: { kind: 'text' | 'tool'; value: string }[] = [];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  let lastFlush = 0;
  const flush = async (force = false): Promise<void> => {
    if (!force && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return;
    lastFlush = Date.now();
    await context.repos.chat.updateMessage(messageId, { content: renderTranscript(parts), toolCalls });
  };

  try {
    const model = await context.repos.settings.text('agents.model');
    const result = await runClaudeCli({
      cwd: context.project.repoPath,
      prompt,
      timeoutMs: config.agents.claudeTimeoutMs,
      binary: config.agents.claudeBinary,
      ...(model ? { model } : {}),
      ...(resuming ? { resumeSessionId: engineSessionId } : { sessionId: engineSessionId }),
      ...policyForPhase('CHAT', {
        allowSubagents: config.agents.allowSubagents,
        chatPermissionMode: session.permissionMode as 'auto',
      }),
      onEvent: async (event: ClaudeStreamEvent) => {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text) parts.push({ kind: 'text', value: block.text });
          if (block.type === 'tool_use' && block.name) {
            toolCalls.push({ name: block.name, input: block.input ?? {} });
            parts.push({ kind: 'tool', value: block.name });
          }
        }
        await flush();
      },
    });

    // The engine may have named the session something other than what we sent,
    // and the next turn has to resume the name it actually used.
    if (result.sessionId && result.sessionId !== session.engineSessionId) {
      await context.repos.chat.updateSession(sessionId, { engineSessionId: result.sessionId });
    }
    // A chat that is still called "New chat" takes its name from the first thing
    // asked in it, which is what a person recognises in a list of twenty.
    if (session.title === 'New chat') {
      const title = prompt.trim().split('\n')[0]?.slice(0, 70) ?? 'New chat';
      await context.repos.chat.updateSession(sessionId, { title });
    }

    // The final result text is the answer; the streamed parts are how it was
    // arrived at. Keeping both, in order, is what makes this a transcript rather
    // than a summary.
    if (result.text && !parts.some((part) => part.kind === 'text' && part.value.includes(result.text.slice(0, 40)))) {
      parts.push({ kind: 'text', value: result.text });
    }
    await context.repos.chat.updateMessage(messageId, {
      content: renderTranscript(parts),
      toolCalls,
      status: 'COMPLETE',
    });
    await context.repos.runs.complete(
      run.id,
      runCompletion({
        usage: result.usage,
        costUsd: result.costUsd,
        modelUsage: result.modelUsage,
        subagentStats: result.subagentStats,
        sessionId: result.sessionId,
        resumed: resuming,
        model: model || null,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Whatever had streamed so far is kept: a turn that died half way through
    // still said something, and throwing it away would make the failure look
    // like the engine never answered at all.
    await context.repos.chat.updateMessage(messageId, {
      content: renderTranscript(parts),
      toolCalls,
      status: 'FAILED',
      error: message,
    });
    await context.repos.runs.fail(run.id, message, failRunSpend(error));
    throw error;
  }
}
