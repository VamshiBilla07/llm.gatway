import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';

/** Build the provider registry from config. Providers without credentials are skipped. */
export function buildProviders(config) {
  const out = new Map();
  for (const [name, p] of Object.entries(config.providers)) {
    if (p.type === 'openai') {
      const usable = p.apiKey || p.enabled;
      if (usable) out.set(name, new OpenAICompatibleProvider({ name, ...p }));
    } else if (p.type === 'gemini' && p.apiKey) {
      out.set(name, new GeminiProvider({ name, ...p }));
    }
  }
  if (config.mockProvider) out.set('mock', new MockProvider());
  return out;
}
