/** Truncates tool output so a single call can never flood an LLM context window. */
export function truncate(value: string, maxChars: number): { text: string; truncated: boolean; originalLength: number } {
  if (value.length <= maxChars) return { text: value, truncated: false, originalLength: value.length };
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const text =
    value.slice(0, head) +
    `\n\n... [truncated ${value.length - maxChars} characters] ...\n\n` +
    value.slice(value.length - tail);
  return { text, truncated: true, originalLength: value.length };
}

export function indent(value: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Extracts the first fenced JSON block, falling back to the first balanced object. */
export function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.split('\n').length;
}
