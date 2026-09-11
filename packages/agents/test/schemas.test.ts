import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateImplementationOutcome,
  validateIntakeResult,
  validateLearningResult,
  validateQaReport,
  validateResearchFindings,
  validateReviewDocument,
  validateReviewPatch,
} from '../src/schemas.ts';
import { REVIEW_SECTIONS } from '@ai-engine/domain';

test('a review document keeps only the known sections', () => {
  const document = validateReviewDocument({
    summary: 'a summary',
    sections: { recommended_approach: 'do this', invented_section: 'ignored' },
    implementationSteps: [{ title: 'step', detail: 'detail' }],
  });

  assert.equal(document.summary, 'a summary');
  assert.equal(document.sections.find((section) => section.key === 'recommended_approach')?.body, 'do this');
  assert.equal(document.sections.some((section) => (section.key as string) === 'invented_section'), false);
  assert.equal(document.implementationSteps[0]?.order, 1);
});

test('a section given as an array is flattened rather than lost', () => {
  const document = validateReviewDocument({
    summary: 's',
    sections: { risks: ['first risk', 'second risk'] },
  });
  const risks = document.sections.find((section) => section.key === 'risks')?.body ?? '';
  assert.ok(risks.includes('first risk'));
  assert.ok(risks.includes('second risk'));
});

test('a patch keeps only the sections it names, and only the known ones', () => {
  const patch = validateReviewPatch({
    sections: { risks: 'a new risk', invented_section: 'ignored' },
  });

  assert.deepEqual(Object.keys(patch.sections ?? {}), ['risks']);
  assert.equal(patch.sections?.risks, 'a new risk');
  // The absent keys must not appear at all: an empty body here would erase the
  // section on merge rather than leave it alone.
  assert.equal(patch.summary, undefined);
  assert.equal(patch.implementationSteps, undefined);
});

test('a patched section given as an array is flattened rather than lost', () => {
  const patch = validateReviewPatch({ sections: { risks: ['first risk', 'second risk'] } });
  assert.ok(patch.sections?.risks?.includes('first risk'));
  assert.ok(patch.sections?.risks?.includes('second risk'));
});

test('a patch that names nothing fails the run rather than changing nothing quietly', () => {
  assert.throws(() => validateReviewPatch({}), /changed nothing/);
  assert.throws(() => validateReviewPatch({ sections: {} }), /changed nothing/);
  assert.throws(() => validateReviewPatch({ sections: { invented_section: 'x' } }), /changed nothing/);
});

test('a patch may carry every section, which is a full rewrite', () => {
  const sections = Object.fromEntries(REVIEW_SECTIONS.map((key) => [key, `body of ${key}`]));
  const patch = validateReviewPatch({ summary: 'rewritten', sections });

  assert.equal(Object.keys(patch.sections ?? {}).length, REVIEW_SECTIONS.length);
  assert.equal(patch.summary, 'rewritten');
  for (const key of REVIEW_SECTIONS) {
    assert.equal(patch.sections?.[key], `body of ${key}`);
  }
});

test('a patch can set a section to the empty string', () => {
  const patch = validateReviewPatch({ sections: { risks: '' } });
  assert.equal(patch.sections?.risks, '');
});

test('an unknown QA verdict is treated as a rejection', () => {
  const report = validateQaReport({ verdict: 'maybe', summary: 's', findings: [] });
  assert.equal(report.verdict, 'REJECTED');
});

test('QA findings are normalised and given ids', () => {
  const report = validateQaReport({
    verdict: 'REJECTED',
    summary: 's',
    findings: [
      { category: 'nonsense', severity: 'BLOCKING', summary: 'null id crashes the webhook', detail: 'd', suggestedFix: 'f' },
      { summary: '', detail: 'dropped because it says nothing' },
    ],
  });

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.category, 'correctness');
  assert.equal(report.findings[0]!.severity, 'blocking');
  assert.equal(report.findings[0]!.id, 'finding-1');
});

test('research findings tolerate missing arrays', () => {
  const findings = validateResearchFindings({ summary: 'only a summary' });
  assert.equal(findings.summary, 'only a summary');
  assert.deepEqual(findings.relevantFiles, []);
  assert.deepEqual(findings.riskSignals, []);
});

test('implementation impact defaults to a read of a file', () => {
  const outcome = validateImplementationOutcome({
    summary: 's',
    impactedResources: [{ identifier: 'src/a.ts' }, { identifier: '', kind: 'symbol' }],
  });
  assert.equal(outcome.impactedResources.length, 1);
  assert.equal(outcome.impactedResources[0]!.kind, 'file');
  assert.equal(outcome.impactedResources[0]!.access, 'read');
});

test('learning results drop empty statements and clamp confidence', () => {
  const result = validateLearningResult({
    principles: [{ statement: 'prefer extending an existing responsibility' }, { statement: '' }],
    invariants: [{ statement: 'payments are idempotent', confidence: 5 }],
  });

  assert.equal(result.principles.length, 1);
  assert.equal(result.principles[0]!.category, 'general');
  assert.equal(result.invariants[0]!.confidence, 1);
});

test('a review without a brief parses, and the domain reports the gap', () => {
  // Absent is a real answer: a document written before the brief existed has
  // none, and inventing a headline here would hide that from the validator.
  const document = validateReviewDocument({ summary: 'Something', sections: {} });
  assert.equal(document.brief, null);
  assert.deepEqual(document.decisions, []);
});

test('a brief is read whole, including the lists', () => {
  const document = validateReviewDocument({
    summary: 'Something',
    brief: {
      headline: 'New addresses are verified before they are trusted',
      approach: 'A pending column and a signed token.',
      changes: ['user.ts gains pending_email', 'one migration'],
      watchOut: ['a backfill on a hot table'],
      effort: '4 files, one migration',
    },
    sections: {},
  });
  assert.equal(document.brief?.changes.length, 2);
  assert.equal(document.brief?.watchOut[0], 'a backfill on a hot table');
});

test('a decision keeps its key so an answer survives a regeneration', () => {
  const document = validateReviewDocument({
    summary: 'Something',
    sections: {},
    decisions: [
      {
        key: 'old-address-window',
        question: 'Should the old address be able to cancel?',
        blocking: true,
        options: [
          { key: 'yes', label: 'Yes, for seven days', detail: 'Keeps it active', consequence: 'Two live addresses' },
          { key: 'no', label: 'No', detail: 'Replace immediately', consequence: 'A typo locks someone out' },
        ],
      },
    ],
  });
  assert.equal(document.decisions[0]?.key, 'old-address-window');
  assert.equal(document.decisions[0]?.options.length, 2);
  assert.equal(document.decisions[0]?.blocking, true);
});

test('a decision with no key gets one from its question, not from its position', () => {
  // The position in the list changes between versions and the question usually
  // does not, so a positional key would reopen questions that were answered.
  const document = validateReviewDocument({
    summary: 'Something',
    sections: {},
    decisions: [
      { question: 'Should the old address be able to cancel?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  });
  assert.equal(document.decisions[0]?.key, 'should-the-old-address-be-able-to-cancel');
});

test('a patch that only changes the brief is still a patch', () => {
  const patch = validateReviewPatch({
    brief: { headline: 'A different headline', approach: '', changes: ['one thing'], watchOut: [], effort: '' },
  });
  assert.equal(patch.brief?.headline, 'A different headline');
  assert.equal(patch.sections, undefined);
});

test('a QA report carries notes separately from findings', () => {
  const report = validateQaReport({
    verdict: 'APPROVED',
    summary: 'Looks right',
    findings: [],
    notes: [{ summary: 'The happy-path test proves little', detail: 'Expiry is untested', file: 'token.spec.ts' }],
  });
  assert.equal(report.verdict, 'APPROVED');
  assert.equal(report.notes.length, 1);
  assert.equal(report.notes[0]?.file, 'token.spec.ts');
});

test('a QA report with no notes field reads as no notes rather than failing', () => {
  const report = validateQaReport({ verdict: 'REJECTED', summary: '', findings: [] });
  assert.deepEqual(report.notes, []);
});

test('an intake round that asks nothing and produces nothing is rejected', () => {
  // Either outcome is useful; neither is a round that cost tokens and produced a
  // screen with nothing on it.
  assert.throws(() => validateIntakeResult({ understanding: 'I think I see' }));
});

test('an intake round keeps at most three options and drops a question with one', () => {
  const result = validateIntakeResult({
    understanding: 'Verify new email addresses',
    questions: [
      {
        question: 'Should the old address keep working?',
        rationale: 'It changes the data model',
        options: [{ label: 'Yes' }, { label: 'No' }, { label: 'For a week' }, { label: 'A fourth' }],
      },
      { question: 'Anything else?', rationale: '', options: [{ label: 'Only one' }] },
    ],
  });
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]?.options.length, 3);
});

test('an intake round that produced stories is ready, whatever it claimed', () => {
  const result = validateIntakeResult({
    understanding: 'Two separate changes',
    ready: false,
    questions: [{ question: 'q', rationale: '', options: [{ label: 'a' }, { label: 'b' }] }],
    stories: [
      { title: 'Verify new addresses', body: 'Do not trust an address until it is confirmed.', rationale: 'ships alone' },
    ],
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.questions, []);
  assert.equal(result.stories.length, 1);
});

test('two questions that reduce to the same key do not collide', () => {
  // The key is unique per review version in the database, so a collision would
  // fail the insert and take the whole review run with it.
  const document = validateReviewDocument({
    summary: 'Something',
    sections: {},
    decisions: [
      { question: 'Should it expire?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Should it expire?', options: [{ label: 'Maybe' }, { label: 'Never' }] },
    ],
  });
  const keys = document.decisions.map((decision) => decision.key);
  assert.equal(new Set(keys).size, 2, `keys must be distinct, got ${keys.join(', ')}`);
  assert.equal(keys[0], 'should-it-expire');
  assert.equal(keys[1], 'should-it-expire-2');
});
