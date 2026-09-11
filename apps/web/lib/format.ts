/**
 * Tokens, with a unit so a seven-figure number can be read at a glance.
 *
 * Nothing in this cockpit formats money. The engine reports a cost per run and
 * the database keeps it, but the account this runs on is a subscription with a
 * weekly token limit: a dollar figure answers a question nobody is asking and
 * invites being read as the bill.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** The exact count, for the one place that has room for it. */
export function formatTokensExact(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * How long something took, in the largest unit that still reads as at least one.
 *
 * Seconds matter for a command and are noise for an agent run, so the unit
 * follows the magnitude rather than being fixed.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const MINUTE = 60_000;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * MINUTE],
  ['month', 30 * 24 * 60 * MINUTE],
  ['week', 7 * 24 * 60 * MINUTE],
  ['day', 24 * 60 * MINUTE],
  ['hour', 60 * MINUTE],
  ['minute', MINUTE],
];

// Created once rather than per row: these pages re-render on a poll.
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * How long ago something happened, in the largest unit that still reads as at
 * least one.
 *
 * The browser and the API keep separate clocks, so something created seconds ago
 * can arrive dated slightly in the future. Both ends clamp to the same string
 * rather than reading "in 3 seconds".
 */
export function relativeAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'unknown';
  const elapsed = now - parsed;
  if (elapsed < MINUTE) return 'just now';
  for (const [unit, size] of UNITS) {
    const magnitude = Math.floor(elapsed / size);
    if (magnitude >= 1) return RELATIVE.format(-magnitude, unit);
  }
  return 'just now';
}

/** A clock time, for a log line where the date is already obvious. */
export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A date and time, written the way the design system writes dates. */
export function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed
    .toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    .toUpperCase();
}
