import 'dotenv/config';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const flag = (v) => v === '1' || v === 'true';

/**
 * Prices are USD per 1M tokens. They are ILLUSTRATIVE reference prices
 * ("what this would cost on a paid plan") so the budget + cost tracking
 * features can be demonstrated while you stay on free tiers. Edit freely.
 */
export function buildConfig(e = env) {
  return {
    port: num(e.PORT, 3000),
    mongoUri: e.MONGODB_URI || '',
    redisUrl: e.REDIS_URL || '',
    signupCode: e.SIGNUP_CODE || '',
    defaults: { rpm: num(e.DEFAULT_RPM, 20), budgetUsd: num(e.DEFAULT_BUDGET_USD, 1) },
    cache: { ttlSeconds: num(e.CACHE_TTL_SECONDS, 3600), maxEntries: 1000 },
    upstream: { timeoutMs: num(e.UPSTREAM_TIMEOUT_MS, 30000), retries: num(e.UPSTREAM_RETRIES, 1) },
    breaker: { failureThreshold: num(e.BREAKER_FAILURES, 3), cooldownMs: num(e.BREAKER_COOLDOWN_MS, 30000) },
    logRetentionDays: num(e.LOG_RETENTION_DAYS, 30),
    providerOrder: (e.PROVIDER_ORDER || 'groq,gemini,openrouter,ollama')
      .split(',').map((s) => s.trim()).filter(Boolean),
    mockProvider: flag(e.MOCK_PROVIDER),
    providers: {
      groq: {
        type: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: e.GROQ_API_KEY,
        models: {
          fast: { id: e.GROQ_MODEL_FAST || 'llama-3.1-8b-instant', in: 0.05, out: 0.08 },
          smart: { id: e.GROQ_MODEL_SMART || 'llama-3.3-70b-versatile', in: 0.59, out: 0.79 },
        },
      },
      gemini: {
        type: 'gemini',
        apiKey: e.GEMINI_API_KEY,
        models: {
          fast: { id: e.GEMINI_MODEL_FAST || 'gemini-flash-lite-latest', in: 0.1, out: 0.4 },
          smart: { id: e.GEMINI_MODEL_SMART || 'gemini-flash-latest', in: 0.75, out: 3.75 },
        },
      },
      openrouter: {
        type: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: e.OPENROUTER_API_KEY,
        models: {
          fast: { id: e.OPENROUTER_MODEL_FAST || 'meta-llama/llama-3.3-70b-instruct:free', in: 0, out: 0 },
          smart: { id: e.OPENROUTER_MODEL_SMART || 'meta-llama/llama-3.3-70b-instruct:free', in: 0, out: 0 },
        },
      },
      ollama: {
        type: 'openai',
        baseUrl: e.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
        apiKey: '',
        enabled: flag(e.OLLAMA_ENABLED),
        models: {
          fast: { id: e.OLLAMA_MODEL_FAST || 'llama3.2:3b', in: 0, out: 0 },
          smart: { id: e.OLLAMA_MODEL_SMART || 'llama3.2:3b', in: 0, out: 0 },
        },
      },
    },
  };
}

export const config = buildConfig();
