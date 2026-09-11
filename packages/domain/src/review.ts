import { requiredSectionsFor, type TaskSize } from './task-size';

/**
 * The engineering review is a structured document, not free text. The section
 * list is fixed so that review versions can be diffed against each other.
 */
export const REVIEW_SECTIONS = [
  'story_understanding',
  'current_system_behavior',
  'relevant_architecture',
  'execution_data_flow',
  'affected_modules',
  'affected_files',
  'affected_symbols',
  'database_impact',
  'api_contract_impact',
  'configuration_impact',
  'dependencies',
  'external_research_findings',
  'recommended_approach',
  'why_this_approach',
  'downsides_tradeoffs',
  'risks',
  'edge_cases',
  'migration_considerations',
  'testing_strategy',
  'implementation_plan',
  'expected_changed_files',
  'open_decisions',
] as const;

export type ReviewSectionKey = (typeof REVIEW_SECTIONS)[number];

export const REVIEW_SECTION_TITLES: Record<ReviewSectionKey, string> = {
  story_understanding: 'Story Understanding',
  current_system_behavior: 'Current System Behavior',
  relevant_architecture: 'Relevant Architecture',
  execution_data_flow: 'Execution / Data Flow',
  affected_modules: 'Affected Modules',
  affected_files: 'Affected Files',
  affected_symbols: 'Affected Symbols',
  database_impact: 'Database Impact',
  api_contract_impact: 'API / Contract Impact',
  configuration_impact: 'Configuration Impact',
  dependencies: 'Dependencies',
  external_research_findings: 'External Research Findings',
  recommended_approach: 'Recommended Approach',
  why_this_approach: 'Why This Approach',
  downsides_tradeoffs: 'Downsides / Trade-offs',
  risks: 'Risks',
  edge_cases: 'Edge Cases',
  migration_considerations: 'Migration Considerations',
  testing_strategy: 'Testing Strategy',
  implementation_plan: 'Implementation Plan',
  expected_changed_files: 'Expected Changed Files / Symbols',
  open_decisions: 'Open Decisions / Blocking Questions',
};

/** Sections an agent must never leave empty. */
export const REQUIRED_REVIEW_SECTIONS: readonly ReviewSectionKey[] = [
  'story_understanding',
  'current_system_behavior',
  'recommended_approach',
  'why_this_approach',
  'downsides_tradeoffs',
  'risks',
  'testing_strategy',
  'implementation_plan',
  'expected_changed_files',
];

export interface ReviewSection {
  key: ReviewSectionKey;
  title: string;
  body: string;
}

export interface ImplementationStep {
  order: number;
  title: string;
  detail: string;
  files: string[];
}

export interface ReviewDocument {
  summary: string;
  sections: ReviewSection[];
  implementationSteps: ImplementationStep[];
  expectedFiles: string[];
  expectedSymbols: string[];
  riskSignals: { indicator: string; evidence: string }[];
  openQuestions: string[];
}

export function emptyReviewDocument(): ReviewDocument {
  return {
    summary: '',
    sections: REVIEW_SECTIONS.map((key) => ({ key, title: REVIEW_SECTION_TITLES[key], body: '' })),
    implementationSteps: [],
    expectedFiles: [],
    expectedSymbols: [],
    riskSignals: [],
    openQuestions: [],
  };
}

/**
 * Which sections must be filled depends on how big the change is: a one file
 * fix earns a short review, and demanding the full twenty two sections for it
 * is what made small stories expensive.
 */
export function validateReviewDocument(document: ReviewDocument, size?: TaskSize): string[] {
  const problems: string[] = [];
  const byKey = new Map(document.sections.map((section) => [section.key, section]));
  const required = size ? requiredSectionsFor(size) : REQUIRED_REVIEW_SECTIONS;
  for (const key of required) {
    const section = byKey.get(key);
    if (!section || section.body.trim().length === 0) {
      problems.push(`Required section "${REVIEW_SECTION_TITLES[key]}" is empty.`);
    }
  }
  if (document.implementationSteps.length === 0) {
    problems.push('The implementation plan must contain at least one step.');
  }
  if (document.summary.trim().length === 0) {
    problems.push('The review summary is empty.');
  }
  return problems;
}

/** Renders the review as markdown for human reading and for agent prompts. */
export function renderReviewMarkdown(document: ReviewDocument): string {
  const parts: string[] = [];
  parts.push(`# Engineering Review\n\n${document.summary.trim()}\n`);
  for (const section of document.sections) {
    if (!section.body.trim()) continue;
    parts.push(`## ${section.title}\n\n${section.body.trim()}\n`);
  }
  if (document.implementationSteps.length > 0) {
    const steps = document.implementationSteps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((step) => {
        const files = step.files.length > 0 ? `\n   Files: ${step.files.join(', ')}` : '';
        return `${step.order}. **${step.title}** — ${step.detail}${files}`;
      })
      .join('\n');
    parts.push(`## Implementation Plan (structured)\n\n${steps}\n`);
  }
  if (document.openQuestions.length > 0) {
    parts.push(`## Open Questions\n\n${document.openQuestions.map((q) => `- ${q}`).join('\n')}\n`);
  }
  return parts.join('\n');
}

/**
 * The parts of a review a regeneration actually changed.
 *
 * Answering one note does not change twenty two sections, so a regeneration is
 * asked for the ones it is changing rather than for the whole document. Every
 * field is optional and absence means "leave it alone", which is what lets an
 * untouched section carry across byte for byte instead of being rewritten into
 * something equivalent.
 */
export interface ReviewPatch {
  summary?: string;
  sections?: Partial<Record<ReviewSectionKey, string>>;
  implementationSteps?: ImplementationStep[];
  expectedFiles?: string[];
  expectedSymbols?: string[];
  riskSignals?: { indicator: string; evidence: string }[];
  openQuestions?: string[];
}

/**
 * Applies a regeneration's patch onto the version it was written against.
 *
 * Presence is the whole signal: a section the patch names replaces that body
 * entirely, including with an empty string, so a note can still demand a full
 * rewrite or ask for a section to be emptied. A section the patch does not name
 * keeps the previous body unchanged, character for character, which is what
 * makes the version diff honest — a section nobody touched stops reporting
 * itself as changed.
 *
 * This is the exact inverse of diffReviewDocuments, and lives beside it for that
 * reason: if the two ever disagree the only place it shows is a badge in the
 * cockpit claiming a section moved when it did not.
 */
export function mergeReviewDocument(previous: ReviewDocument, patch: ReviewPatch): ReviewDocument {
  const patched = patch.sections ?? {};
  const previousBodies = new Map(previous.sections.map((section) => [section.key, section.body]));

  // Sections the previous version carried, plus any the patch introduces. A key
  // neither of them mentions is not invented here.
  const keys = REVIEW_SECTIONS.filter((key) => previousBodies.has(key) || patched[key] !== undefined);

  return {
    summary: patch.summary ?? previous.summary,
    sections: keys.map((key) => {
      const body = patched[key];
      return {
        key,
        title: REVIEW_SECTION_TITLES[key],
        body: body !== undefined ? body : (previousBodies.get(key) ?? ''),
      };
    }),
    implementationSteps: patch.implementationSteps ?? previous.implementationSteps,
    expectedFiles: patch.expectedFiles ?? previous.expectedFiles,
    expectedSymbols: patch.expectedSymbols ?? previous.expectedSymbols,
    riskSignals: patch.riskSignals ?? previous.riskSignals,
    openQuestions: patch.openQuestions ?? previous.openQuestions,
  };
}

export interface ReviewSectionDiff {
  key: ReviewSectionKey;
  title: string;
  status: 'unchanged' | 'changed' | 'added' | 'removed';
  before: string;
  after: string;
}

/** Section level diff between two review versions, shown next to review v2. */
export function diffReviewDocuments(before: ReviewDocument, after: ReviewDocument): ReviewSectionDiff[] {
  const beforeMap = new Map(before.sections.map((section) => [section.key, section.body.trim()]));
  const afterMap = new Map(after.sections.map((section) => [section.key, section.body.trim()]));
  const keys = new Set<ReviewSectionKey>([...beforeMap.keys(), ...afterMap.keys()]);
  const diffs: ReviewSectionDiff[] = [];
  for (const key of REVIEW_SECTIONS) {
    if (!keys.has(key)) continue;
    const beforeBody = beforeMap.get(key) ?? '';
    const afterBody = afterMap.get(key) ?? '';
    let status: ReviewSectionDiff['status'] = 'unchanged';
    if (beforeBody === afterBody) status = 'unchanged';
    else if (!beforeBody) status = 'added';
    else if (!afterBody) status = 'removed';
    else status = 'changed';
    diffs.push({ key, title: REVIEW_SECTION_TITLES[key], status, before: beforeBody, after: afterBody });
  }
  return diffs;
}
