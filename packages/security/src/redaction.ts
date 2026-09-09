const PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai_key', regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack_token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'connection_string', regex: /\b(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@[^\s]+/g },
  { name: 'env_assignment', regex: /\b([A-Z0-9_]*(SECRET|PASSWORD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*("?[^\s"']{6,}"?)/g },
];

export interface RedactionResult {
  text: string;
  redactions: { name: string; count: number }[];
}

/**
 * Every tool result passes through here before it reaches an LLM prompt or the
 * event log. Raw secrets must never enter a model context.
 */
export function redact(input: string, extraSecrets: string[] = []): RedactionResult {
  let text = input;
  const redactions: { name: string; count: number }[] = [];

  for (const secret of extraSecrets) {
    if (secret.length < 6) continue;
    const parts = text.split(secret);
    if (parts.length > 1) {
      text = parts.join('[REDACTED]');
      redactions.push({ name: 'configured_secret', count: parts.length - 1 });
    }
  }

  for (const pattern of PATTERNS) {
    let count = 0;
    text = text.replace(pattern.regex, (match, ...args) => {
      count++;
      if (pattern.name === 'env_assignment') {
        const key = args[0] as string;
        return `${key}=[REDACTED]`;
      }
      if (pattern.name === 'connection_string') {
        return match.replace(/:\/\/([^\s:@/]+):([^\s@]+)@/, '://$1:[REDACTED]@');
      }
      return '[REDACTED]';
    });
    if (count > 0) redactions.push({ name: pattern.name, count });
  }

  return { text, redactions };
}

export function containsSecret(input: string): boolean {
  return redact(input).redactions.length > 0;
}
