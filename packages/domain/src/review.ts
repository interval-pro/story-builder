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

export function validateReviewDocument(document: ReviewDocument): string[] {
  const problems: string[] = [];
  const byKey = new Map(document.sections.map((section) => [section.key, section]));
  for (const key of REQUIRED_REVIEW_SECTIONS) {
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
