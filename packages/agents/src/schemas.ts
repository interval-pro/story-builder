import { ValidationError } from '@ai-engine/shared';
import {
  REVIEW_SECTIONS,
  REVIEW_SECTION_TITLES,
  type ImplementationStep,
  type QaFinding,
  type QaNote,
  type ReviewBrief,
  type ReviewDecision,
  type ReviewDecisionOption,
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
 * The short version of the review.
 *
 * Absent is a real answer rather than an error: a document written before the
 * brief existed has none, and the validator's job is to say what arrived, not to
 * invent a headline. `validateReviewDocument` in the domain is what reports an
 * empty brief as a gap.
 */
function readBrief(value: unknown): ReviewBrief | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    headline: asString(record['headline']).trim(),
    approach: asString(record['approach']).trim(),
    changes: asStringArray(record['changes']),
    watchOut: asStringArray(record['watchOut']),
    effort: asString(record['effort']).trim(),
  };
}

/** A decision's option keys are made stable here rather than trusted. */
function readDecisionOptions(value: unknown): ReviewDecisionOption[] {
  const raw = Array.isArray(value) ? (value as unknown[]) : [];
  return raw
    .map((entry, index) => {
      const item = asRecord(entry, 'Decision option');
      return {
        key: asString(item['key']).trim() || `option-${index + 1}`,
        label: asString(item['label']).trim(),
        detail: asString(item['detail']).trim(),
        consequence: asString(item['consequence']).trim(),
        recommended: Boolean(item['recommended']),
      };
    })
    .filter((option) => option.label.length > 0);
}

/**
 * Questions the review is handing to a person.
 *
 * The key is what survives a regeneration, so an answer given against version 2
 * is still recognised in version 3. The agent is asked for one; a missing key is
 * derived from the question text rather than from the position in the list,
 * because the position changes and the question usually does not.
 */
function readDecisions(value: unknown): ReviewDecision[] {
  const raw = Array.isArray(value) ? (value as unknown[]) : [];
  const decisions = raw
    .map((entry) => {
      const item = asRecord(entry, 'Decision');
      const question = asString(item['question']).trim();
      const explicitKey = asString(item['key']).trim();
      return {
        key: explicitKey || slugKey(question),
        question,
        detail: asString(item['detail']).trim(),
        blocking: Boolean(item['blocking']),
        options: readDecisionOptions(item['options']),
      };
    })
    .filter((decision) => decision.question.length > 0);

  // Keys are unique per review version in the database, and two questions that
  // reduce to the same slug would make the insert fail and take the whole review
  // run with it. The first one keeps the key; a later collision is suffixed
  // rather than dropped, because a question nobody sees is worse than an ugly key.
  const seen = new Set<string>();
  return decisions.map((decision) => {
    if (!seen.has(decision.key)) {
      seen.add(decision.key);
      return decision;
    }
    let suffix = 2;
    while (seen.has(`${decision.key}-${suffix}`)) suffix += 1;
    const key = `${decision.key}-${suffix}`;
    seen.add(key);
    return { ...decision, key };
  });
}

function slugKey(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'decision';
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
    brief: readBrief(record['brief']),
    sections,
    implementationSteps: readImplementationSteps(record['implementationSteps']),
    expectedFiles: asStringArray(record['expectedFiles']),
    expectedSymbols: asStringArray(record['expectedSymbols']),
    riskSignals: readRiskSignals(record['riskSignals']),
    openQuestions: asStringArray(record['openQuestions']),
    decisions: readDecisions(record['decisions']),
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
  const brief = readBrief(record['brief']);
  if (brief) patch.brief = brief;
  if (Array.isArray(record['decisions'])) patch.decisions = readDecisions(record['decisions']);

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
  /**
   * Remarks the run is not blocking on.
   *
   * They were being described in the summary prose, which meant the fix agent
   * never saw them and the next iteration raised them again as if new. A note is
   * not a finding: it does not reject the change and it does not have to be
   * acted on. It does have to be written down.
   */
  notes: QaNote[];
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

  const notesRaw = Array.isArray(record['notes']) ? (record['notes'] as unknown[]) : [];
  const notes: QaNote[] = notesRaw
    .map((entry) => {
      const item = asRecord(entry, 'QA note');
      return {
        summary: asString(item['summary']).trim(),
        detail: asString(item['detail']).trim(),
        file: asString(item['file']).trim() || null,
      };
    })
    .filter((note) => note.summary.length > 0);

  return {
    verdict: verdict as QaReport['verdict'],
    summary: asString(record['summary']),
    findings,
    notes,
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

export interface IntakeQuestion {
  question: string;
  rationale: string;
  options: { key: string; label: string; detail: string }[];
}

export interface IntakeStory {
  title: string;
  body: string;
  rationale: string;
}

export interface IntakeResult {
  /** What the agent takes the idea to be, shown before any question is asked. */
  understanding: string;
  /** True when it has enough to write the stories and is not asking anything. */
  ready: boolean;
  questions: IntakeQuestion[];
  stories: IntakeStory[];
}

/**
 * What the intake agent returns.
 *
 * Asking and answering are the same shape on purpose: a round either produces
 * questions or produces stories, and the caller decides what to do with whichever
 * arrived rather than running two different agents.
 *
 * Options are capped at three. A question with eight options is a form, and the
 * whole point of this step is that a person answers it with a click.
 */
export function validateIntakeResult(value: unknown): IntakeResult {
  const record = asRecord(value, 'Intake result');
  const questionsRaw = Array.isArray(record['questions']) ? (record['questions'] as unknown[]) : [];
  const storiesRaw = Array.isArray(record['stories']) ? (record['stories'] as unknown[]) : [];

  const questions: IntakeQuestion[] = questionsRaw
    .map((entry) => {
      const item = asRecord(entry, 'Intake question');
      const optionsRaw = Array.isArray(item['options']) ? (item['options'] as unknown[]) : [];
      const options = optionsRaw
        .map((option, index) => {
          const record_ = asRecord(option, 'Intake option');
          return {
            key: asString(record_['key']).trim() || `option-${index + 1}`,
            label: asString(record_['label']).trim(),
            detail: asString(record_['detail']).trim(),
          };
        })
        .filter((option) => option.label.length > 0)
        .slice(0, 3);
      return {
        question: asString(item['question']).trim(),
        rationale: asString(item['rationale']).trim(),
        options,
      };
    })
    .filter((question) => question.question.length > 0 && question.options.length >= 2);

  const stories: IntakeStory[] = storiesRaw
    .map((entry) => {
      const item = asRecord(entry, 'Intake story');
      return {
        title: asString(item['title']).trim(),
        body: asString(item['body']).trim(),
        rationale: asString(item['rationale']).trim(),
      };
    })
    .filter((story) => story.title.length > 0 && story.body.length > 0);

  // Readiness is what actually arrived, not what the agent claimed: a round with
  // no stories cannot be ready however it labelled itself, and one that produced
  // stories is finished whether or not it also asked something.
  const ready = stories.length > 0;
  if (!ready && questions.length === 0) {
    throw new ValidationError(
      'The intake produced neither a question to ask nor a story to run, so there is nothing to show.',
    );
  }

  return {
    understanding: asString(record['understanding']).trim(),
    ready,
    questions: ready ? [] : questions,
    stories,
  };
}
