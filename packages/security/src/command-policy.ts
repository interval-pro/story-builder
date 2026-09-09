import { PermissionDeniedError } from '@ai-engine/shared';

/** Commands an agent may run while it only has read capabilities. */
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'file', 'stat', 'du', 'tree',
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pip', 'pytest',
  'go', 'cargo', 'dotnet', 'mvn', 'gradle', 'make', 'jq', 'sed', 'awk', 'sort', 'uniq',
  'echo', 'pwd', 'env', 'which', 'test', 'diff',
]);

/** Argument patterns that are refused regardless of the granted capability. */
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, reason: 'Deleting the filesystem root is never allowed' },
  { pattern: /\bmkfs\b/, reason: 'Formatting devices is never allowed' },
  { pattern: /\bdd\s+if=.*of=\/dev\//, reason: 'Writing to block devices is never allowed' },
  { pattern: /:\(\)\s*\{.*\|\s*:\s*&\s*\}\s*;/, reason: 'Fork bombs are never allowed' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, reason: 'Host power control is never allowed' },
  { pattern: /\bdocker\b/, reason: 'Agents have no access to the Docker daemon' },
  { pattern: /\bkubectl\b|\bhelm\b/, reason: 'Cluster access is never allowed' },
  { pattern: /\bcurl\b[^|]*\|\s*(ba)?sh/, reason: 'Piping downloaded scripts into a shell is never allowed' },
  { pattern: /\bsudo\b|\bsu\b\s/, reason: 'Privilege escalation is never allowed' },
  { pattern: /\bgit\s+push\b/, reason: 'Pushing requires the push capability and a human approval' },
  { pattern: /\bgit\s+remote\s+(add|set-url)\b/, reason: 'Changing Git remotes is never allowed' },
  { pattern: /\/etc\/(passwd|shadow|sudoers)/, reason: 'Host credential files are out of scope' },
  { pattern: /\bnc\b\s+-l|\bncat\b\s+-l/, reason: 'Opening listeners is not allowed' },
];

export interface CommandCheck {
  allowed: boolean;
  reason?: string;
  binary: string;
}

function firstBinary(command: string): string {
  const trimmed = command.trim();
  const withoutEnv = trimmed.replace(/^(\w+=\S+\s+)+/, '');
  const token = withoutEnv.split(/\s+/)[0] ?? '';
  return token.split('/').pop() ?? token;
}

export function inspectCommand(command: string, mode: 'safe' | 'full'): CommandCheck {
  const binary = firstBinary(command);
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(command)) {
      return { allowed: false, reason: rule.reason, binary };
    }
  }
  if (mode === 'safe' && !SAFE_COMMANDS.has(binary)) {
    return { allowed: false, reason: `Command "${binary}" is not in the read-only allow list`, binary };
  }
  if (mode === 'safe' && /(^|\s)(>|>>)\s*\S/.test(command)) {
    return { allowed: false, reason: 'Output redirection is a write operation', binary };
  }
  if (mode === 'safe' && /\bgit\s+(commit|checkout|merge|rebase|reset|clean|apply|stash)\b/.test(command)) {
    return { allowed: false, reason: 'Only read-only Git commands are allowed in this phase', binary };
  }
  return { allowed: true, binary };
}

export function assertCommandAllowed(command: string, mode: 'safe' | 'full'): void {
  const check = inspectCommand(command, mode);
  if (!check.allowed) {
    throw new PermissionDeniedError(check.reason ?? 'Command is not allowed', { command, binary: check.binary });
  }
}

export function isSafeBinary(binary: string): boolean {
  return SAFE_COMMANDS.has(binary);
}
