import type { ImpactResource } from '@ai-engine/domain';

/** Derives an impact manifest from a review document. */
export function impactFromReview(expectedFiles: string[], expectedSymbols: string[]): ImpactResource[] {
  const resources: ImpactResource[] = [];
  for (const file of expectedFiles) {
    resources.push({ kind: 'file', identifier: file, access: 'write', source: 'review' });
    if (/migrations?\//i.test(file)) {
      resources.push({ kind: 'migration', identifier: file, access: 'write', source: 'review' });
    }
  }
  for (const symbol of expectedSymbols) {
    resources.push({ kind: 'symbol', identifier: symbol, access: 'write', source: 'review' });
  }
  return resources;
}
