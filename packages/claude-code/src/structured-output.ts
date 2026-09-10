import { AppError } from '@ai-engine/shared';

function candidates(raw: string): string[] {
  const found: string[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) found.push(fenced[1].trim());

  // Brace matching, aware of strings and escapes, so an object that contains
  // braces or fences inside its own text is still taken whole.
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index++) {
      const char = raw[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          found.push(raw.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Turns the answer pass into an object.
 *
 * A fenced block is the usual shape but not a promise: the answer can contain
 * fences of its own, and the model can write JSON that does not parse. Every
 * plausible candidate is tried, and when none of them parses the caller gets
 * one recognisable failure instead of a parser error from deep inside.
 */
export function parseStructuredAnswer(raw: string): unknown {
  let lastError: string | null = null;
  for (const candidate of candidates(raw)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new AppError('structured_output_failed', 'The agent did not return parseable JSON', 502, {
    reason: lastError ?? 'no JSON object was found in the answer',
    preview: raw.slice(0, 500),
  });
}
