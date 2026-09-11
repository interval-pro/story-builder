import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateImplementationOutcome,
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
