import { loadAgentPrompt, runIntakeAgent, type AnsweredIntakeQuestion } from '@ai-engine/agents';
import { loadConfig } from '@ai-engine/shared';
import { toolPolicyVersion } from '@ai-engine/tools';
import { buildProjectAgentContext, createProjectAgentRunner, type ProjectJobContext } from '../project-context';
import { runCompletion } from '../job-context';

/**
 * After this many rounds the intake must produce stories rather than ask again.
 *
 * Three is enough for the questions that matter and few enough that the step
 * stays the cheap one. An intake that cannot settle an idea in three rounds is
 * telling you the idea needs a conversation with a person, not another question
 * from an agent.
 */
const MAX_ROUNDS = 3;

/** The answer a person gave, as a sentence the agent can read back. */
function renderAnswer(question: {
  question: string;
  options: { key: string; label: string; detail: string }[];
  chosenKey: string | null;
  customAnswer: string | null;
}): AnsweredIntakeQuestion {
  if (question.chosenKey === 'custom' && question.customAnswer) {
    return { question: question.question, answer: question.customAnswer };
  }
  const chosen = question.options.find((option) => option.key === question.chosenKey);
  const answer = chosen ? `${chosen.label}. ${chosen.detail}` : (question.customAnswer ?? 'No answer was given.');
  return { question: question.question, answer };
}

/**
 * One round of turning an idea into stories.
 *
 * A round either asks questions or produces drafts. When it asks, the session
 * waits for a person and this job ends; answering enqueues the next round. That
 * shape is deliberate: a job that sat waiting for an answer would hold a queue
 * slot for as long as the person took to come back.
 */
export async function handleIdeaIntake(context: ProjectJobContext): Promise<void> {
  const sessionId = String(context.job.payload['sessionId'] ?? '');
  if (!sessionId) throw new Error(`Intake job ${context.job.id} names no session`);

  const session = await context.repos.ideas.getById(sessionId);
  if (session.status === 'DISCARDED') {
    context.logger.info('the idea was discarded before this round ran', { sessionId });
    return;
  }

  const round = session.round + 1;
  await context.repos.ideas.update(sessionId, { status: 'THINKING', round });

  const questions = await context.repos.ideas.listQuestions(sessionId);
  const answers = questions.filter((question) => question.answeredAt).map(renderAnswer);

  const prompt = await loadAgentPrompt('intake', context.installRoot);
  const config = loadConfig();
  const agent = await context.repos.agents.ensureAgent('intake', 'intake agent');
  const version = await context.repos.agents.registerVersion({
    agentId: agent.id,
    prompt,
    provider: config.ai.provider,
    model: config.ai.model,
    modelConfig: {},
    toolPolicyVersion: toolPolicyVersion(),
  });

  // Later rounds continue the first one's session. The agent has already read the
  // repository by then, and re-reading it to answer a follow-up question is the
  // single most wasteful thing this step could do.
  const previousRun = (await context.repos.runs.listBySubject(sessionId)).at(-1);
  const resumeSessionId = previousRun?.sessionId ?? null;

  const run = await context.repos.runs.start({
    projectId: context.project.id,
    kind: 'IDEA',
    subjectId: sessionId,
    phase: 'INTAKE',
    agentType: 'intake',
    agentVersionId: version.id,
    sessionId: resumeSessionId,
    ...(resumeSessionId ? { resumed: true } : {}),
  });

  try {
    const runner = await createProjectAgentRunner({ context, phase: 'INTAKE', size: 'SMALL' });
    const { result, outcome } = await runIntakeAgent({
      runner,
      projectContext: await buildProjectAgentContext(context),
      idea: session.idea,
      answers,
      round,
      finalRound: round >= MAX_ROUNDS,
      installRoot: context.installRoot,
      onSessionStart: async (engineSessionId) => {
        await context.repos.runs.recordSession(run.id, { sessionId: engineSessionId, resumed: Boolean(resumeSessionId) });
      },
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });

    await context.repos.runs.complete(run.id, runCompletion(outcome));

    if (result.ready) {
      await context.repos.ideas.replaceDrafts(
        sessionId,
        context.project.id,
        result.stories.map((story) => ({ title: story.title, body: story.body, rationale: story.rationale })),
      );
      await context.repos.ideas.update(sessionId, {
        status: 'READY',
        understanding: result.understanding || null,
      });
      await context.events.append({
        projectId: context.project.id,
        runId: run.id,
        eventType: 'StoryCreated',
        actorType: 'agent',
        actorId: 'intake',
        payload: { sessionId, drafts: result.stories.length, round },
      });
      return;
    }

    await context.repos.ideas.setQuestions(sessionId, round, result.questions);
    await context.repos.ideas.update(sessionId, {
      status: 'ASKING',
      understanding: result.understanding || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.repos.runs.fail(run.id, message);
    await context.repos.ideas.update(sessionId, { status: 'FAILED', error: message });
    throw error;
  }
}
