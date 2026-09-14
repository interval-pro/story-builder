/**
 * What Postgres cannot store, made storable.
 *
 * Postgres refuses a NUL character in a text column and its JSON escape in a
 * jsonb column, and it refuses the whole statement rather than the one
 * character. Everything an agent produces ends up in one of those: the input of
 * every tool call, a chat message, an event payload. An agent that wrote code
 * containing a NUL once took the worker down with it when the tool call was
 * recorded.
 *
 * The character is replaced rather than dropped, so a record that had one still
 * shows that something was there.
 */

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

function withoutNul(text: string): string {
  return text.includes(NUL) ? text.split(NUL).join(REPLACEMENT) : text;
}

function clean(value: unknown): unknown {
  if (typeof value === 'string') return withoutNul(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[withoutNul(key)] = clean(entry);
    return out;
  }
  // Dates, buffers and anything else with its own toJSON are left to it.
  return value;
}

/** JSON for a jsonb column: JSON.stringify, without the escape Postgres refuses. */
export function toJson(value: unknown): string {
  return JSON.stringify(clean(value));
}

/**
 * Query parameters as the driver should receive them. Strings lose their NUL
 * characters; buffers go to bytea, where a zero byte is valid, and are left
 * alone along with everything else.
 */
export function sanitizeParams(params: readonly unknown[]): unknown[] {
  return params.map((param) => (typeof param === 'string' ? withoutNul(param) : param));
}
