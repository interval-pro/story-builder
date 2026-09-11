import { ValidationError } from '@ai-engine/shared';
import {
  REVIEW_SECTIONS,
  REVIEW_SECTION_TITLES,
  type ImplementationStep,
  type QaFinding,
  type ReviewDocument,
  type ReviewPatch,
  type ReviewSectionKey,
} from '@ai-engine/domain';

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.map((entry) => `- ${asString(entry)}`).join('\n');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).filter((entry) => entry.length > 0);
}

export interface ResearchFindings {
  summary: string;
  relevantFiles: { path: string; why: string }[];
  relevantSymbols: { name: string; path: string; why: string }[];
  executionPaths: string[];
  databaseNotes: string[];
  testNotes: string[];
  dependencyNotes: string[];
  externalFindings: { source: string; trustTier: number; claim: string; validation: string }[];
  openQuestions: string[];
  riskSignals: { indicator: string; evidence: string }[];
}

export function validateResearchFindings(value: unknown): ResearchFindings {
  const record = asRecord(value, 'Research findings');
  const files = Array.isArray(record['relevantFiles']) ? (record['relevantFiles'] as unknown[]) : [];
  const symbols = Array.isArray(record['relevantSymbols']) ? (record['relevantSymbols'] as unknown[]) : [];
  const external = Array.isArray(record['externalFindings']) ? (record['externalFindings'] as unknown[]) : [];
  const risks = Array.isArray(record['riskSignals']) ? (record['riskSignals'] as unknown[]) : [];

  return {
    summary: asString(record['summary']),
    relevantFiles: files.map((entry) => {
      const item = asRecord(entry, 'Relevant file');
      return { path: asString(item['path']), why: asString(item['why']) };
    }).filter((entry) => entry.path.length > 0),
    relevantSymbols: symbols.map((entry) => {
      const item = asRecord(entry, 'Relevant symbol');
      return { name: asString(item['name']), path: asString(item['path']), why: asString(item['why']) };
    }).filter((entry) => entry.name.length > 0),
    executionPaths: asStringArray(record['executionPaths']),
    databaseNotes: asStringArray(record['databaseNotes']),
    testNotes: asStringArray(record['testNotes']),
    dependencyNotes: asStringArray(record['dependencyNotes']),
    externalFindings: external.map((entry) => {
      const item = asRecord(entry, 'External finding');
      return {
        source: asString(item['source']),
        trustTier: Number(item['trustTier'] ?? 5) || 5,
        claim: asString(item['claim']),
        validation: asString(item['validation']),
      };
    }),
    openQuestions: asStringArray(record['openQuestions']),
    riskSignals: risks.map((entry) => {
      const item = asRecord(entry, 'Risk signal');
      return { indicator: asString(item['indicator']), evidence: asString(item['evidence']) };
    }).filter((entry) => entry.indicator.length > 0),
  };
}

function readImplementationSteps(value: unknown): ImplementationStep[] {
  const raw = Array.isArray(value) ? (value as unknown[]) : [];
  return raw.map((entry, index) => {
    const item = asRecord(entry, 'Implementation step');
    return {
      order: Number(item['order'] ?? index + 1) || index + 1,
      title: asString(item['title']),
      detail: asString(item['detail']),
      files: asStringArray(item['files']),
    };
  });
}

function readRiskSignals(value: unknown): { indicator: string; evidence: string }[] {
  const raw = Array.isArray(value) ? (value as unknown[]) : [];
  return raw
    .map((entry) => {
      const item = asRecord(entry, 'Risk signal');
      return { indicator: asString(item['indicator']), evidence: asString(item['evidence']) };
    })
    .filter((entry) => entry.indicator.length > 0);
}

/**
 * The model returns sections as a flat object keyed by section id; anything it
 * invents outside the fixed section list is dropped.
 */
export function validateReviewDocument(value: unknown): ReviewDocument {
  const record = asRecord(value, 'Review document');
  const sectionsRaw = asRecord(record['sections'] ?? {}, 'Review sections');
  const sections = REVIEW_SECTIONS.map((key) => ({
    key,
    title: REVIEW_SECTION_TITLES[key],
    body: asString(sectionsRaw[key]).trim(),
  }));

  return {
    summary: asString(record['summary']).trim(),
    sections,
    implementationSteps: readImplementationSteps(record['implementationSteps']),
    expectedFiles: asStringArray(record['expectedFiles']),
    expectedSymbols: asStringArray(record['expectedSymbols']),
    riskSignals: readRiskSignals(record['riskSignals']),
    openQuestions: asStringArray(record['openQuestions']),
  };
}

/**
 * What a regeneration returns: only the parts it is changing.
 *
 * This deliberately does not map over the fixed section list the way
 * validateReviewDocument does. That map turns an absent key into an empty body,
 * which is right for a document meant to be complete and catastrophic for a
 * patch: every section the agent did not mention would be silently erased and
 * the diff would report it as removed rather than as an error.
 *
 * A patch that names nothing at all throws. A regeneration that changed nothing
 * while marking a human's note addressed is the expensive failure here, so the
 * run fails, the notes stay open and the job retries.
 */
export function validateReviewPatch(value: unknown): ReviewPatch {
  const record = asRecord(value, 'Review patch');
  const sectionsRaw = asRecord(record['sections'] ?? {}, 'Review sections');

  const sections: ReviewSectionMap = {};
  for (const [key, body] of Object.entries(sectionsRaw)) {
    if (!(REVIEW_SECTIONS as readonly string[]).includes(key)) continue;
    sections[key as ReviewSectionKey] = asString(body).trim();
  }

  const patch: ReviewPatch = {};
  if (Object.keys(sections).length > 0) patch.sections = sections;
  if (record['summary'] !== undefined && record['summary'] !== null) {
    patch.summary = asString(record['summary']).trim();
  }
  if (Array.isArray(record['implementationSteps'])) {
    patch.implementationSteps = readImplementationSteps(record['implementationSteps']);
  }
  if (Array.isArray(record['expectedFiles'])) patch.expectedFiles = asStringArray(record['expectedFiles']);
  if (Array.isArray(record['expectedSymbols'])) patch.expectedSymbols = asStringArray(record['expectedSymbols']);
  if (Array.isArray(record['riskSignals'])) patch.riskSignals = readRiskSignals(record['riskSignals']);
  if (Array.isArray(record['openQuestions'])) patch.openQuestions = asStringArray(record['openQuestions']);

  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      'The regenerated review changed nothing: it named no section and no top-level field.',
    );
  }
  return patch;
}

export interface QaReport {
  verdict: 'APPROVED' | 'REJECTED' | 'BLOCKED';
  summary: string;
  findings: QaFinding[];
  /** Set when the fix would change the approved scope and needs a human. */
  requiresSupplementalReview: boolean;
  supplementalReason: string;
}

const QA_CATEGORIES: QaFinding['category'][] = [
  'correctness',
  'regression',
  'edge_case',
  'security',
  'invariant',
  'architecture',
  'migration',
  'tests',
  'performance',
];

const QA_SEVERITIES: QaFinding['severity'][] = ['low', 'medium', 'high', 'blocking'];

export function validateQaReport(value: unknown): QaReport {
  const record = asRecord(value, 'QA report');
  const verdictRaw = asString(record['verdict']).toUpperCase();
  const verdict = verdictRaw === 'APPROVED' || verdictRaw === 'BLOCKED' ? verdictRaw : 'REJECTED';
  const findingsRaw = Array.isArray(record['findings']) ? (record['findings'] as unknown[]) : [];

  const findings: QaFinding[] = findingsRaw.map((entry, index) => {
    const item = asRecord(entry, 'QA finding');
    const category = asString(item['category']) as QaFinding['category'];
    const severity = asString(item['severity']).toLowerCase() as QaFinding['severity'];
    return {
      id: asString(item['id']) || `finding-${index + 1}`,
      category: QA_CATEGORIES.includes(category) ? category : 'correctness',
      severity: QA_SEVERITIES.includes(severity) ? severity : 'medium',
      file: asString(item['file']) || null,
      summary: asString(item['summary']),
      detail: asString(item['detail']),
      suggestedFix: asString(item['suggestedFix']),
      status: 'OPEN' as const,
    };
  }).filter((finding) => finding.summary.length > 0);

  return {
    verdict: verdict as QaReport['verdict'],
    summary: asString(record['summary']),
    findings,
    requiresSupplementalReview: Boolean(record['requiresSupplementalReview']),
    supplementalReason: asString(record['supplementalReason']),
  };
}

export interface ImplementationOutcome {
  summary: string;
  changedFiles: string[];
  deviations: { planned: string; actual: string; reason: string }[];
  testsAdded: string[];
  testsModified: string[];
  testsRemoved: string[];
  testJustification: string;
  discoveredIssues: { title: string; detail: string; requiresSupplementalReview: boolean }[];
  impactedResources: { kind: string; identifier: string; access: 'read' | 'write' }[];
}

export function validateImplementationOutcome(value: unknown): ImplementationOutcome {
  const record = asRecord(value, 'Implementation outcome');
  const deviationsRaw = Array.isArray(record['deviations']) ? (record['deviations'] as unknown[]) : [];
  const issuesRaw = Array.isArray(record['discoveredIssues']) ? (record['discoveredIssues'] as unknown[]) : [];
  const impactRaw = Array.isArray(record['impactedResources']) ? (record['impactedResources'] as unknown[]) : [];

  return {
    summary: asString(record['summary']),
    changedFiles: asStringArray(record['changedFiles']),
    deviations: deviationsRaw.map((entry) => {
      const item = asRecord(entry, 'Deviation');
      return { planned: asString(item['planned']), actual: asString(item['actual']), reason: asString(item['reason']) };
    }),
    testsAdded: asStringArray(record['testsAdded']),
    testsModified: asStringArray(record['testsModified']),
    testsRemoved: asStringArray(record['testsRemoved']),
    testJustification: asString(record['testJustification']),
    discoveredIssues: issuesRaw.map((entry) => {
      const item = asRecord(entry, 'Discovered issue');
      return {
        title: asString(item['title']),
        detail: asString(item['detail']),
        requiresSupplementalReview: Boolean(item['requiresSupplementalReview']),
      };
    }),
    impactedResources: impactRaw.map((entry) => {
      const item = asRecord(entry, 'Impacted resource');
      const access: 'read' | 'write' = asString(item['access']) === 'write' ? 'write' : 'read';
      return { kind: asString(item['kind']) || 'file', identifier: asString(item['identifier']), access };
    }).filter((entry) => entry.identifier.length > 0),
  };
}

export interface LearningResult {
  principles: { category: string; statement: string; scope: string; evidence: string }[];
  invariants: { statement: string; scope: string; confidence: number; evidence: string }[];
}

export function validateLearningResult(value: unknown): LearningResult {
  const record = asRecord(value, 'Learning result');
  const principlesRaw = Array.isArray(record['principles']) ? (record['principles'] as unknown[]) : [];
  const invariantsRaw = Array.isArray(record['invariants']) ? (record['invariants'] as unknown[]) : [];

  return {
    principles: principlesRaw.map((entry) => {
      const item = asRecord(entry, 'Principle');
      return {
        category: asString(item['category']) || 'general',
        statement: asString(item['statement']),
        scope: asString(item['scope']) || 'global',
        evidence: asString(item['evidence']),
      };
    }).filter((entry) => entry.statement.length > 0),
    invariants: invariantsRaw.map((entry) => {
      const item = asRecord(entry, 'Invariant');
      return {
        statement: asString(item['statement']),
        scope: asString(item['scope']) || 'global',
        confidence: Math.min(1, Math.max(0, Number(item['confidence'] ?? 0.5) || 0.5)),
        evidence: asString(item['evidence']),
      };
    }).filter((entry) => entry.statement.length > 0),
  };
}

export type ReviewSectionMap = Partial<Record<ReviewSectionKey, string>>;
