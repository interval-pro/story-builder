export const IMPACT_RESOURCE_KINDS = [
  'file',
  'symbol',
  'module',
  'database_table',
  'database_column',
  'migration',
  'api',
  'event',
  'contract',
  'domain',
  'invariant',
] as const;

export type ImpactResourceKind = (typeof IMPACT_RESOURCE_KINDS)[number];

export interface ImpactResource {
  kind: ImpactResourceKind;
  identifier: string;
  access: 'read' | 'write';
  source: 'review' | 'implementation' | 'qa';
}

export const CONFLICT_KINDS = [
  'git',
  'symbol',
  'migration',
  'schema',
  'contract',
  'semantic',
  'invariant',
] as const;

export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const CONFLICT_SEVERITIES = ['info', 'warning', 'blocking'] as const;
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];

export interface DetectedConflict {
  kind: ConflictKind;
  severity: ConflictSeverity;
  resource: string;
  description: string;
  otherTaskId: string;
}

/** Resources for which a hard lock is taken instead of soft coordination. */
export const HARD_LOCK_KINDS: readonly ImpactResourceKind[] = [
  'database_table',
  'database_column',
  'migration',
  'contract',
  'api',
];

export function requiresHardLock(kind: ImpactResourceKind): boolean {
  return HARD_LOCK_KINDS.includes(kind);
}
