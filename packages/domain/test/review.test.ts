import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffReviewDocuments,
  emptyReviewDocument,
  renderReviewMarkdown,
  validateReviewDocument,
} from '../src/review.ts';

function documentWith(body: string) {
  const document = emptyReviewDocument();
  document.summary = 'A summary';
  for (const section of document.sections) {
    if (
      [
        'story_understanding',
        'current_system_behavior',
        'recommended_approach',
        'why_this_approach',
        'downsides_tradeoffs',
        'risks',
        'testing_strategy',
        'implementation_plan',
        'expected_changed_files',
      ].includes(section.key)
    ) {
      section.body = body;
    }
  }
  document.implementationSteps = [{ order: 1, title: 'Do the thing', detail: 'in this file', files: ['a.ts'] }];
  return document;
}

test('a review missing required sections is reported as incomplete', () => {
  const problems = validateReviewDocument(emptyReviewDocument());
  assert.ok(problems.length > 0);
  assert.ok(problems.some((problem) => problem.includes('Recommended Approach')));
});

test('a complete review has no problems', () => {
  assert.deepEqual(validateReviewDocument(documentWith('real content')), []);
});

test('the markdown rendering skips empty sections', () => {
  const markdown = renderReviewMarkdown(documentWith('real content'));
  assert.ok(markdown.includes('## Recommended Approach'));
  assert.equal(markdown.includes('## Configuration Impact'), false);
});

test('the diff marks changed sections and leaves the rest unchanged', () => {
  const before = documentWith('old content');
  const after = documentWith('old content');
  after.sections.find((section) => section.key === 'recommended_approach')!.body = 'new content';

  const diff = diffReviewDocuments(before, after);
  const changed = diff.filter((entry) => entry.status === 'changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.key, 'recommended_approach');
  assert.equal(changed[0]!.before, 'old content');
  assert.equal(changed[0]!.after, 'new content');
});
