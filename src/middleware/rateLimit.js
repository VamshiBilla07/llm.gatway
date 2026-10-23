import { HttpError } from '../utils/errors.js';

const WINDOW_MS = 60_000;

/** Per-API-key requests-per-minute limit (fixed window). Fails open if the KV store is down. */
export function rateLimit(kv) {
  return async (req, res, next) => {
    const { key } = req.auth;
    let state;
    try {
      state = await kv.hit(`key:${key.id}`, WINDOW_MS);
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: 'rate limiter unavailable, failing open', error: err.message }));
      return next();
    }
    const limit = key.rpm;
    const remaining = Math.max(0, limit - state.count);
    res.set({
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(Math.ceil(state.resetAt / 1000)),
    });
    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000));
      res.set('retry-after', String(retryAfter));
      throw new HttpError(429, `Rate limit exceeded (${limit} requests/minute). Retry in ${retryAfter}s.`, 'rate_limited');
    }
    next();
  };
}
