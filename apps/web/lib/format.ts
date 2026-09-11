/**
 * Money, to four decimals and with no unit ladder. Every amount this system
 * produces is legible at that precision, and a run that cost a fraction of a
 * cent should read as a fraction of a cent rather than as nothing.
 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Thousands separators, so a six-figure token count can be read at a glance. */
export function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}
