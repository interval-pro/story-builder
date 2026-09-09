export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskSignal {
  indicator: RiskIndicator;
  evidence: string;
}

export const RISK_INDICATORS = [
  'database_migration',
  'destructive_operation',
  'authentication',
  'security',
  'core_shared_module',
  'public_api_change',
  'large_blast_radius',
  'deployment_change',
  'data_transformation',
  'weak_test_coverage',
] as const;

export type RiskIndicator = (typeof RISK_INDICATORS)[number];

/** Indicators that on their own are enough to force a second human gate. */
const HIGH_ONLY: readonly RiskIndicator[] = [
  'database_migration',
  'destructive_operation',
  'authentication',
  'security',
  'deployment_change',
  'data_transformation',
];

export interface RiskAssessment {
  level: RiskLevel;
  signals: RiskSignal[];
  reason: string;
}

/**
 * Deliberately simple and conservative: one strong indicator, or two weaker
 * ones, is enough to require the extra execution approval.
 */
export function classifyRisk(signals: RiskSignal[]): RiskAssessment {
  if (signals.length === 0) {
    return { level: 'LOW', signals, reason: 'No risk indicators were detected in the analysis.' };
  }
  const strong = signals.filter((signal) => HIGH_ONLY.includes(signal.indicator));
  if (strong.length > 0) {
    return {
      level: 'HIGH',
      signals,
      reason: `High risk indicators present: ${strong.map((s) => s.indicator).join(', ')}.`,
    };
  }
  if (signals.length >= 2) {
    return {
      level: 'HIGH',
      signals,
      reason: `Multiple medium risk indicators combine into a large blast radius: ${signals
        .map((s) => s.indicator)
        .join(', ')}.`,
    };
  }
  return {
    level: 'MEDIUM',
    signals,
    reason: `Single medium risk indicator: ${signals[0]!.indicator}.`,
  };
}

export function requiresSecondApproval(level: RiskLevel): boolean {
  return level === 'HIGH';
}
