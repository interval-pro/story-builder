const MINUTE = 60_000;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * MINUTE],
  ['month', 30 * 24 * 60 * MINUTE],
  ['week', 7 * 24 * 60 * MINUTE],
  ['day', 24 * 60 * MINUTE],
  ['hour', 60 * MINUTE],
  ['minute', MINUTE],
];

// Created once rather than per row: these pages re-render on a five second poll.
const FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * How long ago something happened, in the largest unit that still reads as at
 * least one. Months and years are day-count approximations, which is accurate
 * enough for a column you scan rather than audit.
 *
 * The clock is injectable so the boundaries can be exercised directly.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  // A timestamp that does not parse should look broken rather than brand new.
  if (!Number.isFinite(parsed)) return 'unknown age';

  // The browser and the API keep separate clocks, so a story created seconds
  // ago can arrive dated slightly in the future. Both ends clamp to the same
  // string rather than reading 'in 3 seconds'.
  const elapsed = now - parsed;
  if (elapsed < MINUTE) return 'just now';

  for (const [unit, size] of UNITS) {
    const magnitude = Math.floor(elapsed / size);
    if (magnitude >= 1) return FORMATTER.format(-magnitude, unit);
  }
  return 'just now';
}
