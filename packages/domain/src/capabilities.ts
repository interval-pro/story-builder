import type { TaskState } from './task-state';

/**
 * Capabilities are granted per execution phase, never globally. The tool layer
 * refuses any call whose required capability is not in the active set.
 */
export const CAPABILITIES = [
  'repo.read',
  'repo.search',
  'git.inspect',
  'command.safe',
  'tests.run',
  'web.research',
  'artifact.read',
  'artifact.write',
  'workspace.write',
  'command.run',
  'build.run',
  'dependencies.modify',
  'database.inspect',
  'database.execute_dev',
  'services.start',
  'git.commit',
  'git.push',
  'github.pull_request',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const EXECUTION_PHASES = ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

const READ_ONLY: Capability[] = [
  'repo.read',
  'repo.search',
  'git.inspect',
  'command.safe',
  'tests.run',
  'artifact.read',
  'artifact.write',
  'database.inspect',
];

export const PHASE_CAPABILITIES: Record<ExecutionPhase, Capability[]> = {
  RESEARCH: [...READ_ONLY, 'web.research'],
  REVIEW: [...READ_ONLY, 'web.research'],
  IMPLEMENTATION: [
    ...READ_ONLY,
    'workspace.write',
    'command.run',
    'build.run',
    'dependencies.modify',
    'database.execute_dev',
    'services.start',
  ],
  QA: [...READ_ONLY],
  FINAL_REPORT: [...READ_ONLY],
  INTEGRATION: [...READ_ONLY, 'workspace.write', 'command.run', 'build.run', 'git.commit'],
  PUSH: [...READ_ONLY, 'git.commit', 'git.push', 'github.pull_request'],
};

export function capabilitiesForPhase(phase: ExecutionPhase): Capability[] {
  return [...PHASE_CAPABILITIES[phase]];
}

export function phaseForState(state: TaskState): ExecutionPhase | null {
  switch (state) {
    case 'ANALYSIS_QUEUED':
    case 'ANALYZING':
      return 'RESEARCH';
    case 'REVIEW_REGENERATING':
      return 'REVIEW';
    case 'IMPLEMENTATION_QUEUED':
    case 'IMPLEMENTING':
    case 'FIX_REQUIRED':
    case 'FIXING':
      return 'IMPLEMENTATION';
    case 'QA_QUEUED':
    case 'QA_RUNNING':
      return 'QA';
    case 'FINAL_REVIEW_READY':
      return 'FINAL_REPORT';
    case 'INTEGRATION_VALIDATION':
      return 'INTEGRATION';
    case 'PUSHING':
      return 'PUSH';
    default:
      return null;
  }
}

export function hasCapability(granted: readonly Capability[], required: Capability): boolean {
  return granted.includes(required);
}
