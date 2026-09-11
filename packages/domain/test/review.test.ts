import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffReviewDocuments,
  emptyReviewDocument,
  mergeReviewDocument,
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

test('a patch rewrites the sections it names and leaves every other one byte-identical', () => {
  const previous = documentWith('old content');
  const merged = mergeReviewDocument(previous, { sections: { recommended_approach: 'new content' } });

  assert.equal(merged.sections.find((section) => section.key === 'recommended_approach')?.body, 'new content');

  const untouched = previous.sections.filter((section) => section.key !== 'recommended_approach');
  assert.equal(untouched.length, 21, 'the other twenty one sections must all still be there');
  for (const section of untouched) {
    const after = merged.sections.find((entry) => entry.key === section.key);
    assert.equal(after?.body, section.body, `${section.key} must be carried across unchanged`);
  }
});

test('the diff after a patch reports exactly the patched sections', () => {
  const previous = documentWith('old content');
  const merged = mergeReviewDocument(previous, {
    sections: { recommended_approach: 'new content', risks: 'new risks' },
  });

  for (const entry of diffReviewDocuments(previous, merged)) {
    const expected = entry.key === 'recommended_approach' || entry.key === 'risks' ? 'changed' : 'unchanged';
    assert.equal(entry.status, expected, `${entry.key} must be ${expected}`);
  }
});

test('a patch can empty a section, and an absent key cannot', () => {
  const previous = documentWith('old content');
  const emptied = mergeReviewDocument(previous, { sections: { risks: '' } });

  assert.equal(emptied.sections.find((section) => section.key === 'risks')?.body, '');
  const removed = diffReviewDocuments(previous, emptied).filter((entry) => entry.status === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.key, 'risks');

  // The same section left out of the patch keeps its body, which is the whole
  // difference between naming a key and not naming it.
  const kept = mergeReviewDocument(previous, { sections: { recommended_approach: 'new content' } });
  assert.equal(kept.sections.find((section) => section.key === 'risks')?.body, 'old content');
});

test('a patch that omits the top-level fields carries all of them across', () => {
  const previous = documentWith('old content');
  previous.expectedFiles = ['a.ts'];
  previous.expectedSymbols = ['doThing'];
  previous.riskSignals = [{ indicator: 'core_shared_module', evidence: 'every phase goes through it' }];
  previous.openQuestions = ['whether the window is right'];

  const merged = mergeReviewDocument(previous, { sections: { risks: 'new risks' } });

  assert.deepEqual(merged.implementationSteps, previous.implementationSteps);
  assert.deepEqual(merged.expectedFiles, previous.expectedFiles);
  assert.deepEqual(merged.expectedSymbols, previous.expectedSymbols);
  assert.deepEqual(merged.riskSignals, previous.riskSignals);
  assert.deepEqual(merged.openQuestions, previous.openQuestions);
  assert.equal(merged.summary, previous.summary);
});

test('a review that was complete stays complete after a patch to an optional section', () => {
  const previous = documentWith('real content');
  assert.deepEqual(validateReviewDocument(previous, 'SMALL'), []);

  // configuration_impact is optional at every size, so patching it must not be
  // able to turn a document the gate accepted into one it rejects.
  const merged = mergeReviewDocument(previous, { sections: { configuration_impact: 'None.' } });
  assert.deepEqual(validateReviewDocument(merged, 'SMALL'), []);
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
