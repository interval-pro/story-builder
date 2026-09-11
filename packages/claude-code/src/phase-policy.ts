import type { ExecutionPhase } from '@ai-engine/domain';
import type { ClaudeCliOptions } from './types';

/** Editing tools, denied outright in every read-only phase. */
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * Commands that stay refused even while the task may write. Pushing needs a
 * separate human approval and is done by the system, never by the agent.
 */
const FORBIDDEN_COMMANDS = [
  'Bash(git push:*)',
  'Bash(git remote:*)',
  'Bash(sudo:*)',
  'Bash(docker:*)',
  'Bash(kubectl:*)',
  'Bash(rm -rf /:*)',
];

/**
 * The chat window is the person's own terminal, opened in the project directory,
 * so it keeps the capabilities they already have there — pushing included. Only
 * the two that are destructive beyond the project stay refused, because nothing
 * a person would type into a project chat needs them and an unattended session
 * cannot be asked.
 */
const CHAT_FORBIDDEN_COMMANDS = ['Bash(sudo:*)', 'Bash(rm -rf /:*)'];

/**
 * Delegation. Each subagent opens its own context window, and none of the five
 * agents has a reason to delegate: each has a narrow job, its own prompt and its
 * own worktree. `Agent` and `Task` are the same tool under two names across CLI
 * versions, and the rest only mean anything once a subagent exists. Denying a
 * name this CLI does not have costs nothing; missing one defeats the purpose.
 */
const DELEGATION_TOOLS = ['Agent', 'Task', 'SendMessage', 'ListAgents', 'TaskOutput', 'TaskStop'];

/**
 * Harness discovery, denied in every phase whatever the subagent setting says.
 * An agent that spends turns finding out what tools exist is not doing the work
 * it was given, and every tool it actually needs is already in its prompt.
 */
const DISCOVERY_TOOLS = ['ToolSearch'];

export type PhasePolicy = Pick<
  ClaudeCliOptions,
  'restricted' | 'permissionMode' | 'allowedTools' | 'disallowedTools' | 'effort'
>;

export interface PolicyOptions {
  /** Defaults to false. Set from AGENT_ALLOW_SUBAGENTS, never read here. */
  allowSubagents?: boolean;
  /**
   * What a chat session may do. Only the CHAT phase reads it; every other phase
   * has a permission mode that follows from what that phase is allowed to be.
   */
  chatPermissionMode?: PhasePolicy['permissionMode'];
  /**
   * The effort the answer pass runs at. Only answerPassPolicy reads it: a work
   * pass gets its effort from its phase, optionally overridden by size.
   */
  effort?: PhasePolicy['effort'];
}

/** The denials every pass of every phase carries, on top of its own. */
function overheadTools(options: PolicyOptions): string[] {
  return options.allowSubagents ? DISCOVERY_TOOLS : [...DISCOVERY_TOOLS, ...DELEGATION_TOOLS];
}

/**
 * Translates the capability model onto the CLI's own permission flags. The
 * read-only phases are enforced twice: the CLI refuses the tools, and in Docker
 * mode the workspace is mounted read-only underneath it.
 */
export function policyForPhase(phase: ExecutionPhase, options: PolicyOptions = {}): PhasePolicy {
  const overhead = overheadTools(options);
  switch (phase) {
    case 'INTAKE':
      // Shaping an idea into stories. It reads the repository so its questions
      // are about this code rather than about software in general, and it has
      // nothing to write to: there is no task and no branch yet.
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: [...EDIT_TOOLS, ...overhead],
        effort: 'medium',
      };
    case 'CHAT':
      // Deliberately the widest policy here, and the only one a person drives
      // turn by turn. Narrowing it would make the chat something other than the
      // terminal it is meant to replace.
      return {
        permissionMode: options.chatPermissionMode ?? 'acceptEdits',
        disallowedTools: [...CHAT_FORBIDDEN_COMMANDS, ...overhead],
      };
    case 'RESEARCH':
    case 'REVIEW':
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: [...EDIT_TOOLS, ...overhead],
        effort: 'high',
      };
    case 'QA':
    case 'FINAL_REPORT':
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: [...EDIT_TOOLS, ...overhead],
        effort: 'xhigh',
      };
    case 'IMPLEMENTATION':
    case 'INTEGRATION':
      // `auto`, not `acceptEdits`. Measured against CLI 2.1.268: under
      // `acceptEdits` the agent may write files but `npm test` and `npm run build`
      // are refused — they prompt, and a headless session has nobody to prompt,
      // so the prompt is auto-denied. The implementation agent is told to verify
      // the build and the tests before reporting success, and for three sessions
      // it reported, accurately, that it could not run anything at all.
      //
      // `auto` lets those commands run while the deny list below still holds:
      // confirmed by running `git push --dry-run` under `auto` with this list,
      // which came back refused with a recorded denial. So pushing stays a step
      // the system performs after a human approval, never something an agent can
      // reach.
      return {
        permissionMode: 'auto',
        disallowedTools: [...FORBIDDEN_COMMANDS, ...overhead],
        effort: 'xhigh',
      };
    case 'PUSH':
      // Pushing is done by the system after the human approval, not by an agent.
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: [...EDIT_TOOLS, ...FORBIDDEN_COMMANDS, ...overhead],
        effort: 'low',
      };
  }
}

/** Tools the answer pass has no use for: it reads nothing and writes JSON. */
const ANSWER_PASS_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

/**
 * The pass that asks for the structured answer. It is the same boundary as a
 * phase policy, so it is built here rather than a second time at the call site:
 * a denial added in one place has to reach both or the hole is invisible.
 *
 * It carries the effort its work pass ran at. This pass resumes that same
 * session, and changing the effort inside a session rebuilds the prompt cache
 * from scratch. Before this took an effort that happened on every run of every
 * phase, because the work pass set the flag and this one left it off. Passing it
 * through lowers no phase's effort; it only stops the two halves disagreeing.
 */
export function answerPassPolicy(options: PolicyOptions = {}): PhasePolicy {
  return {
    restricted: true,
    permissionMode: 'dontAsk',
    disallowedTools: [...ANSWER_PASS_TOOLS, ...overheadTools(options)],
    ...(options.effort ? { effort: options.effort } : {}),
  };
}

/** True when the phase must not be able to change a single file. */
export function isReadOnlyPhase(phase: ExecutionPhase): boolean {
  return ['RESEARCH', 'REVIEW', 'QA', 'FINAL_REPORT', 'PUSH'].includes(phase);
}
