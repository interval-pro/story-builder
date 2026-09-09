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

export type PhasePolicy = Pick<
  ClaudeCliOptions,
  'restricted' | 'permissionMode' | 'allowedTools' | 'disallowedTools' | 'effort'
>;

/**
 * Translates the capability model onto the CLI's own permission flags. The
 * read-only phases are enforced twice: the CLI refuses the tools, and in Docker
 * mode the workspace is mounted read-only underneath it.
 */
export function policyForPhase(phase: ExecutionPhase): PhasePolicy {
  switch (phase) {
    case 'RESEARCH':
    case 'REVIEW':
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: EDIT_TOOLS,
        effort: 'high',
      };
    case 'QA':
    case 'FINAL_REPORT':
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: EDIT_TOOLS,
        effort: 'xhigh',
      };
    case 'IMPLEMENTATION':
    case 'INTEGRATION':
      return {
        permissionMode: 'acceptEdits',
        disallowedTools: FORBIDDEN_COMMANDS,
        effort: 'xhigh',
      };
    case 'PUSH':
      // Pushing is done by the system after the human approval, not by an agent.
      return {
        restricted: true,
        permissionMode: 'dontAsk',
        disallowedTools: [...EDIT_TOOLS, ...FORBIDDEN_COMMANDS],
        effort: 'low',
      };
  }
}

/** True when the phase must not be able to change a single file. */
export function isReadOnlyPhase(phase: ExecutionPhase): boolean {
  return ['RESEARCH', 'REVIEW', 'QA', 'FINAL_REPORT', 'PUSH'].includes(phase);
}
