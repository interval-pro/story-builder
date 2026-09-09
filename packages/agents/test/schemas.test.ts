import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateImplementationOutcome,
  validateLearningResult,
  validateQaReport,
  validateResearchFindings,
  validateReviewDocument,
} from '../src/schemas.ts';

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
