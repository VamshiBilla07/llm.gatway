/**
 * Tiny key-value + counter abstraction used by the response cache and the rate limiter.
 * MemoryKV works out of the box; RedisKV (e.g. Upstash free tier) is used when REDIS_URL is set,
 * so multiple gateway instances share the same cache and limits.
 */
export class MemoryKV {
  constructor({ maxEntries = 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.data = new Map();
    this.windows = new Map();
    this.kind = 'memory';
  }

  async get(key) {
    const hit = this.data.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key, value, ttlSeconds) {
    if (this.data.size >= this.maxEntries) this.data.delete(this.data.keys().next().value); // evict oldest
    this.data.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  /** Fixed-window counter. Returns { count, resetAt }. */
  async hit(key, windowMs) {
    const now = this.now();
    const bucket = Math.floor(now / windowMs);
    const w = this.windows.get(key);
    if (!w || w.bucket !== bucket) {
      if (this.windows.size > 10000) this.windows.clear(); // crude memory guard
      this.windows.set(key, { bucket, count: 1 });
      return { count: 1, resetAt: (bucket + 1) * windowMs };
    }
    w.count += 1;
    return { count: w.count, resetAt: (bucket + 1) * windowMs };
  }
}

export class RedisKV {
  constructor(redis, now = Date.now) {
    this.redis = redis;
    this.now = now;
    this.kind = 'redis';
  }

  async get(key) {
    return this.redis.get(`cache:${key}`);
  }

  async set(key, value, ttlSeconds) {
    await this.redis.set(`cache:${key}`, value, 'EX', ttlSeconds);
  }

  async hit(key, windowMs) {
    const bucket = Math.floor(this.now() / windowMs);
    const k = `rl:${key}:${bucket}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, windowMs);
    return { count, resetAt: (bucket + 1) * windowMs };
  }
}

export async function createKV(config) {
  if (!config.redisUrl) return new MemoryKV({ maxEntries: config.cache.maxEntries });
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', (e) => console.error(JSON.stringify({ level: 'warn', msg: 'redis error', error: e.message })));
  return new RedisKV(redis);
}
