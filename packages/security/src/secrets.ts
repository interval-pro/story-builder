import { PermissionDeniedError } from '@ai-engine/shared';

export type SecretScope = 'llm_provider' | 'github' | 'package_registry' | 'development_api' | 'production';

export interface SecretDefinition {
  key: string;
  scope: SecretScope;
  envVar: string;
}

/**
 * Secrets are resolved by scope, never handed to agents. Production scope is
 * denied by default and has no allow path in v0.
 */
export class SecretsService {
  private readonly definitions = new Map<string, SecretDefinition>();
  private readonly allowedScopes: Set<SecretScope>;

  constructor(definitions: SecretDefinition[] = DEFAULT_SECRETS, allowedScopes: SecretScope[] = ['llm_provider', 'github', 'package_registry', 'development_api']) {
    for (const definition of definitions) this.definitions.set(definition.key, definition);
    this.allowedScopes = new Set(allowedScopes);
  }

  register(definition: SecretDefinition): void {
    this.definitions.set(definition.key, definition);
  }

  /** Returns the secret value for infrastructure code only. */
  resolve(key: string): string | undefined {
    const definition = this.definitions.get(key);
    if (!definition) return undefined;
    if (definition.scope === 'production' || !this.allowedScopes.has(definition.scope)) {
      throw new PermissionDeniedError(`Secret ${key} is in a denied scope`, { key, scope: definition.scope });
    }
    return process.env[definition.envVar];
  }

  /** All secret values currently visible, used to scrub tool output. */
  knownValues(): string[] {
    const values: string[] = [];
    for (const definition of this.definitions.values()) {
      const value = process.env[definition.envVar];
      if (value && value.length >= 6) values.push(value);
    }
    return values;
  }

  /** Environment variables that may be injected into a task sandbox. */
  sandboxEnvironment(scopes: SecretScope[]): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const definition of this.definitions.values()) {
      if (!scopes.includes(definition.scope)) continue;
      if (definition.scope === 'production') continue;
      const value = process.env[definition.envVar];
      if (value) environment[definition.envVar] = value;
    }
    return environment;
  }
}

export const DEFAULT_SECRETS: SecretDefinition[] = [
  { key: 'ai.api_key', scope: 'llm_provider', envVar: 'AI_API_KEY' },
  { key: 'anthropic.api_key', scope: 'llm_provider', envVar: 'ANTHROPIC_API_KEY' },
  { key: 'openai.api_key', scope: 'llm_provider', envVar: 'OPENAI_API_KEY' },
  { key: 'github.token', scope: 'github', envVar: 'GITHUB_TOKEN' },
  { key: 'npm.token', scope: 'package_registry', envVar: 'NPM_TOKEN' },
  { key: 'dev.database_url', scope: 'development_api', envVar: 'DEV_DATABASE_URL' },
];
