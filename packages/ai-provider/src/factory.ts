import { AppError, createLogger, loadConfig, type AiProviderConfig } from '@ai-engine/shared';
import type { AiProvider } from './types';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';
import { MockProvider } from './providers/mock';

const logger = createLogger('ai-provider');

/**
 * Agent configuration decides the provider and model; the rest of the system
 * only ever sees the AiProvider interface.
 */
export function createProvider(overrides: Partial<AiProviderConfig> = {}): AiProvider {
  const config = { ...loadConfig().ai, ...overrides };
  switch (config.provider) {
    case 'anthropic': {
      if (!config.apiKey) throw new AppError('missing_configuration', 'AI_API_KEY is required for the Anthropic provider', 500);
      return new AnthropicProvider(config.model, config.apiKey, config.baseUrl);
    }
    case 'openai': {
      if (!config.apiKey) throw new AppError('missing_configuration', 'AI_API_KEY is required for the OpenAI provider', 500);
      return new OpenAiProvider(config.model, config.apiKey, config.baseUrl);
    }
    case 'mock':
      return new MockProvider(config.model);
    default:
      throw new AppError('invalid_configuration', `Unknown AI provider: ${String(config.provider)}`, 500);
  }
}

/** Falls back to the mock provider instead of crashing when no key is present. */
export function createProviderOrMock(overrides: Partial<AiProviderConfig> = {}): AiProvider {
  try {
    return createProvider(overrides);
  } catch (error) {
    logger.warn('falling back to the mock provider', { error });
    return new MockProvider();
  }
}
