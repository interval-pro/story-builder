/**
 * The settings the cockpit may change while the system runs.
 *
 * Everything else stays an environment variable read once at startup, which is
 * right for anything a restart would have to follow anyway: ports, database
 * URLs, paths. What is here is what a person needs to change without touching a
 * file: a token, how much runs at once, and the ceiling usage is measured
 * against.
 *
 * The descriptors travel to the cockpit so the settings screen is generated from
 * this list rather than hand-written twice.
 */
export type SettingKind = 'text' | 'secret' | 'integer' | 'boolean' | 'choice';

export interface SettingDescriptor {
  key: string;
  label: string;
  /** What it does and what changes when you change it. */
  help: string;
  kind: SettingKind;
  /** The value used when nothing is stored and no environment variable is set. */
  defaultValue: string;
  /** Environment variable consulted before the default. */
  envVar?: string;
  choices?: { value: string; label: string; help: string }[];
  min?: number;
  max?: number;
  /** Which screen section it belongs to. */
  group: 'queue' | 'usage' | 'agents' | 'integration' | 'chat';
}

export const SETTING_KEYS = {
  queueConcurrency: 'queue.concurrency',
  queuePaused: 'queue.paused',
  weeklyTokenBudget: 'usage.weeklyTokenBudget',
  githubToken: 'github.token',
  maxQaIterations: 'qa.maxIterations',
  claudeModel: 'agents.model',
  implementationContextCeiling: 'agents.implementationContextCeiling',
  chatPermissionMode: 'chat.permissionMode',
} as const;

export const SETTING_DESCRIPTORS: SettingDescriptor[] = [
  {
    key: SETTING_KEYS.queueConcurrency,
    label: 'Jobs at once',
    help:
      'How many agent sessions and test runs may happen at the same time, across every project. ' +
      'They share one account limit and one machine, so one is the honest default. Raising it does ' +
      'not make a single story faster; it makes several stories progress together.',
    kind: 'integer',
    defaultValue: '1',
    min: 1,
    max: 8,
    group: 'queue',
  },
  {
    key: SETTING_KEYS.queuePaused,
    label: 'Queue paused',
    help:
      'While paused, nothing new starts. Work already running finishes rather than being killed, ' +
      'and everything waiting stays exactly where it is in the order.',
    kind: 'boolean',
    defaultValue: 'false',
    group: 'queue',
  },
  {
    key: SETTING_KEYS.weeklyTokenBudget,
    label: 'Weekly token budget',
    help:
      'A ceiling you choose, measured against a rolling seven days of real usage. It is not the ' +
      'account limit: the engine does not report that, so nothing here can know it. Zero turns the ' +
      'budget off and leaves the usage figure on its own.',
    kind: 'integer',
    defaultValue: '0',
    min: 0,
    group: 'usage',
  },
  {
    key: SETTING_KEYS.githubToken,
    label: 'GitHub token',
    help:
      'Injected into each push, so pushing never depends on a desktop credential helper and the ' +
      'token never lands in a git config. Contents and pull requests, read and write, on the ' +
      'repositories you want pull requests for. Without one, a task stops at a local branch.',
    kind: 'secret',
    defaultValue: '',
    envVar: 'GITHUB_TOKEN',
    group: 'integration',
  },
  {
    key: SETTING_KEYS.maxQaIterations,
    label: 'Fix cycles before a human',
    help:
      'How many times the checks may reject the change and send it back before the task stops and ' +
      'waits for you. Each cycle is a full agent run.',
    kind: 'integer',
    defaultValue: '5',
    envVar: 'MAX_QA_ITERATIONS',
    min: 1,
    max: 10,
    group: 'agents',
  },
  {
    key: SETTING_KEYS.claudeModel,
    label: 'Model override',
    help: 'Sent to the CLI for every agent. Leave empty to use whatever your CLI login defaults to.',
    kind: 'text',
    defaultValue: '',
    envVar: 'CLAUDE_MODEL',
    group: 'agents',
  },
  {
    key: SETTING_KEYS.implementationContextCeiling,
    label: 'Implementation context ceiling',
    help:
      'A fix normally continues the session that wrote the code, which is cheap while that session ' +
      'is small. Past this many cached tokens it starts a fresh one from the approved plan and the ' +
      'open findings instead. This is the single largest lever on what a story costs: the bill is ' +
      'turns multiplied by context size, so a session left to grow to the size of the window is ' +
      're-read on every turn.',
    kind: 'integer',
    defaultValue: '400000',
    min: 50000,
    group: 'agents',
  },
  {
    key: SETTING_KEYS.chatPermissionMode,
    label: 'What the chat may do',
    help:
      'The chat window runs the engine in the project directory, the way your own terminal does. ' +
      'This decides how much it may do without asking, and it cannot ask: there is no terminal to ' +
      'ask in.',
    kind: 'choice',
    defaultValue: 'auto',
    choices: [
      {
        value: 'dontAsk',
        label: 'Read only',
        help: 'It can read and search the project and answer questions. It cannot change a file or run anything.',
      },
      {
        value: 'acceptEdits',
        label: 'Edit files only',
        help:
          'It may edit files, but commands are refused: they would prompt, and there is no terminal here to ' +
          'prompt in. Measured, not assumed — under this mode a plain "npm test" comes back refused.',
      },
      {
        value: 'auto',
        label: 'Edit and run',
        help:
          'Edits and commands both work, which is what makes this the same thing as your own terminal. ' +
          'Pushing, sudo and deleting the root are still refused.',
      },
      {
        value: 'bypassPermissions',
        label: 'Everything',
        help:
          'Nothing held back at all, including pushing. This is your terminal with no one watching it, in a ' +
          'directory that is not a sandbox.',
      },
    ],
    group: 'chat',
  },
];

export function settingDescriptor(key: string): SettingDescriptor | undefined {
  return SETTING_DESCRIPTORS.find((descriptor) => descriptor.key === key);
}

/** Parses a stored string against its descriptor, falling back to the default. */
export function settingAsInteger(value: string | undefined, descriptor: SettingDescriptor): number {
  const parsed = Number.parseInt(value ?? descriptor.defaultValue, 10);
  if (!Number.isFinite(parsed)) return Number.parseInt(descriptor.defaultValue, 10);
  const floor = descriptor.min ?? Number.NEGATIVE_INFINITY;
  const ceiling = descriptor.max ?? Number.POSITIVE_INFINITY;
  return Math.min(ceiling, Math.max(floor, parsed));
}

export function settingAsBoolean(value: string | undefined, descriptor: SettingDescriptor): boolean {
  const raw = (value ?? descriptor.defaultValue).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
