import { sha256 } from '../utils/hash.js';

/** Exact-match response cache. Fails open: any KV error is treated as a miss. */
export class ResponseCache {
  constructor(kv, ttlSeconds) {
    this.kv = kv;
    this.ttlSeconds = ttlSeconds;
  }

  static keyFor({ model, messages, temperature, maxTokens }) {
    return sha256(JSON.stringify({ model, messages, temperature: temperature ?? null, maxTokens: maxTokens ?? null }));
  }

  async get(key) {
    try {
      const raw = await this.kv.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async set(key, value) {
    try {
      await this.kv.set(key, JSON.stringify(value), this.ttlSeconds);
    } catch {
      /* cache is best-effort */
    }
  }
}
