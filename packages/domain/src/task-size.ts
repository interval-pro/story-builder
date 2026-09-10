import type { ReviewSectionKey } from './review';

/**
 * How much ceremony a change is worth.
 *
 * The same lifecycle runs for a one line shell fix and for a change across a
 * dozen files, and until now both produced the same twenty two section review.
 * Sizing the documents to the change is what keeps a small story cheap without
 * making a large one thin.
 */
export type TaskSize = 'SMALL' | 'STANDARD' | 'LARGE';

export function classifyTaskSize(input: { fileCount: number; riskSignalCount: number }): TaskSize {
  if (input.fileCount > 8 || input.riskSignalCount >= 3) return 'LARGE';
  if (input.fileCount <= 2 && input.riskSignalCount === 0) return 'SMALL';
  return 'STANDARD';
}

const SMALL_SECTIONS: readonly ReviewSectionKey[] = [
  'story_understanding',
  'current_system_behavior',
  'recommended_approach',
  'downsides_tradeoffs',
  'testing_strategy',
  'implementation_plan',
  'expected_changed_files',
];

const STANDARD_SECTIONS: readonly ReviewSectionKey[] = [
  ...SMALL_SECTIONS,
  'why_this_approach',
  'risks',
  'affected_files',
];

const LARGE_SECTIONS: readonly ReviewSectionKey[] = [
  ...STANDARD_SECTIONS,
  'relevant_architecture',
  'execution_data_flow',
  'edge_cases',
  'affected_symbols',
];

/** Sections the review must fill at this size. Others stay optional. */
export function requiredSectionsFor(size: TaskSize): readonly ReviewSectionKey[] {
  switch (size) {
    case 'SMALL':
      return SMALL_SECTIONS;
    case 'STANDARD':
      return STANDARD_SECTIONS;
    default:
      return LARGE_SECTIONS;
  }
}

/** The budget the review agent is told to work inside. */
export function reviewBudgetFor(size: TaskSize): { maxWordsPerSection: number; guidance: string } {
  switch (size) {
    case 'SMALL':
      return {
        maxWordsPerSection: 120,
        guidance:
          'This is a small change. Fill only the required sections and keep each under 120 words. ' +
          'Leave every other section empty rather than restating what you already said. One or two ' +
          'implementation steps is normal here; do not invent more to look thorough.',
      };
    case 'STANDARD':
      return {
        maxWordsPerSection: 250,
        guidance:
          'This is an ordinary change. Fill the required sections and any other section that carries ' +
          'a fact the implementer needs. Keep each under 250 words.',
      };
    default:
      return {
        maxWordsPerSection: 400,
        guidance:
          'This change is large or risky. Fill every section that applies and take the room you need, ' +
          'up to about 400 words each. Depth here is worth its cost.',
      };
  }
}
