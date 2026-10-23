import { ProviderError } from '../utils/errors.js';
import { HttpError } from '../utils/errors.js';
import { CircuitBreaker } from './circuitBreaker.js';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cheap heuristic: long, multi-turn, or code/analysis-looking prompts go to the "smart" tier. */
export function pickTier(messages) {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (chars > 1500 || messages.length > 8) return 'smart';
  if (/```|\b(code|debug|refactor|prove|analy[sz]e|step[- ]by[- ]step|algorithm)\b/i.test(lastUser)) return 'smart';
  return 'fast';
}

export class Router {
  constructor({ providers, order, upstream, breakerConfig, sleep = sleepReal, backoffMs = 250 }) {
    this.providers = providers; // Map<name, provider>
    this.order = order;
    this.timeoutMs = upstream.timeoutMs;
    this.retries = upstream.retries;
    this.breakerConfig = breakerConfig;
    this.sleep = sleep;
    this.backoffMs = backoffMs;
    this.breakers = new Map();
  }

  breaker(name) {
    if (!this.breakers.has(name)) this.breakers.set(name, new CircuitBreaker(this.breakerConfig));
    return this.breakers.get(name);
  }

  status() {
    return [...this.providers.keys()].map((name) => ({ provider: name, ...this.breaker(name).snapshot() }));
  }

  /**
   * Decide which providers/models to try, in order.
   *   "auto"            -> heuristic tier, then every provider in PROVIDER_ORDER
   *   "fast" | "smart"  -> forced tier, with fallback
   *   "groq/model-id"   -> pinned to that provider+model, NO fallback
   */
  plan(requestedModel, messages) {
    const model = requestedModel || 'auto';
    const slash = model.indexOf('/');
    if (slash > 0) {
      const provider = this.providers.get(model.slice(0, slash));
      if (provider) {
        const id = model.slice(slash + 1);
        const known = Object.values(provider.models).find((m) => m.id === id);
        return { tier: 'pinned', candidates: [{ provider, model: known ?? { id, in: 0, out: 0 } }] };
      }
    }
    const tier = model === 'fast' || model === 'smart' ? model : pickTier(messages);
    const candidates = this.order
      .map((name) => this.providers.get(name))
      .filter(Boolean)
      .map((provider) => ({ provider, model: provider.models[tier] }));
    // mock provider isn't in PROVIDER_ORDER by default; include it if it's the only thing configured
    if (!candidates.length && this.providers.has('mock')) {
      const p = this.providers.get('mock');
      candidates.push({ provider: p, model: p.models[tier] });
    }
    return { tier, candidates };
  }

  async #execute(plan, req, attemptFn) {
    if (!plan.candidates.length) {
      throw new HttpError(503, 'No LLM providers are configured on this gateway', 'no_providers');
    }
    const attempts = [];
    for (const cand of plan.candidates) {
      const name = cand.provider.name;
      const breaker = this.breaker(name);
      if (!breaker.canRequest()) {
        attempts.push({ provider: name, ok: false, error: 'circuit open' });
        continue;
      }
      for (let i = 0; ; i++) {
        try {
          const value = await attemptFn(cand);
          breaker.success();
          attempts.push({ provider: name, ok: true });
          return { value, cand, attempts };
        } catch (err) {
          if (req.signal?.aborted) throw new HttpError(499, 'client closed request', 'client_closed');
          if (!(err instanceof ProviderError)) throw err;
          if (err.retryable && i < this.retries) {
            await this.sleep(this.backoffMs * 2 ** i);
            continue;
          }
          attempts.push({ provider: name, ok: false, status: err.status, error: err.message });
          if (!err.failover) {
            breaker.success(); // provider is healthy; the request itself was bad
            throw new HttpError(400, err.message, 'invalid_request', { attempts });
          }
          breaker.failure();
          break; // go to next provider
        }
      }
    }
    throw new HttpError(502, 'All providers failed or are temporarily unavailable', 'upstream_unavailable', { attempts });
  }

  /** Non-streaming request with retry, circuit breaking and fallback. */
  async chat(plan, req) {
    const { value, cand, attempts } = await this.#execute(plan, req, (c) => {
      const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(req.signal ? [req.signal] : [])]);
      return c.provider.chat({ ...req, model: c.model.id, signal });
    });
    return { result: value, provider: cand.provider.name, model: cand.model, attempts };
  }

  /**
   * Streaming request. Fallback only happens BEFORE the first chunk arrives
   * (after that the client has already received bytes), so we wait for the first chunk.
   */
  async stream(plan, req) {
    const { value, cand, attempts } = await this.#execute(plan, req, async (c) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new DOMException('first chunk timeout', 'TimeoutError')), this.timeoutMs);
      const signal = AbortSignal.any([ctrl.signal, ...(req.signal ? [req.signal] : [])]);
      try {
        const gen = c.provider.stream({ ...req, model: c.model.id, signal });
        const first = await gen.next();
        return { first, gen };
      } finally {
        clearTimeout(timer);
      }
    });
    const { first, gen } = value;
    const iterator = (async function* () {
      if (!first.done) yield first.value;
      yield* gen;
    })();
    return { iterator, provider: cand.provider.name, model: cand.model, attempts };
  }
}
