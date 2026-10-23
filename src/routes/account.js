import { Router } from 'express';
import { HttpError } from '../utils/errors.js';
import { generateApiKey } from '../utils/hash.js';
import { requireAuth } from '../middleware/auth.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_ACTIVE_KEYS = 5;

export function accountRoutes({ store, kv, config }) {
  const r = Router();
  const auth = requireAuth(store);

  // Public. Protected by an optional invite code + a per-IP hourly limit so strangers can't drain your free quota.
  r.post('/signup', async (req, res) => {
    const { email, inviteCode } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL.test(email)) throw new HttpError(400, 'A valid "email" is required', 'invalid_email');
    if (config.signupCode && inviteCode !== config.signupCode) throw new HttpError(403, 'Invalid invite code', 'invalid_invite');
    try {
      const { count } = await kv.hit(`signup:${req.ip}`, 3_600_000);
      if (count > 10) throw new HttpError(429, 'Too many signups from this IP, try later', 'rate_limited');
    } catch (e) {
      if (e instanceof HttpError) throw e; // KV down: fail open
    }
    const normalized = email.trim().toLowerCase();
    if (await store.findUserByEmail(normalized)) throw new HttpError(409, 'Email already registered', 'email_taken');
    const user = await store.createUser({ email: normalized });
    const { key, prefix, hash } = generateApiKey();
    await store.createKey({ userId: user.id, name: 'default', prefix, hash, rpm: config.defaults.rpm, budgetUsd: config.defaults.budgetUsd });
    res.status(201).json({
      user: { id: user.id, email: user.email },
      apiKey: key,
      note: 'Store this key now. It cannot be shown again.',
    });
  });

  r.post('/keys', auth, async (req, res) => {
    const keys = await store.listKeys(req.auth.userId);
    if (keys.filter((k) => !k.revokedAt).length >= MAX_ACTIVE_KEYS) {
      throw new HttpError(400, `Max ${MAX_ACTIVE_KEYS} active keys`, 'too_many_keys');
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 50) : 'key';
    const { key, prefix, hash } = generateApiKey();
    const created = await store.createKey({
      userId: req.auth.userId, name, prefix, hash,
      rpm: config.defaults.rpm, budgetUsd: config.defaults.budgetUsd,
    });
    res.status(201).json({ id: created.id, name, apiKey: key, note: 'Store this key now. It cannot be shown again.' });
  });

  r.get('/keys', auth, async (req, res) => {
    const keys = await store.listKeys(req.auth.userId);
    res.json({
      keys: keys.map((k) => ({
        id: k.id, name: k.name, prefix: k.prefix, rpm: k.rpm,
        budgetUsd: k.budgetUsd, spentUsd: Number(k.spentUsd.toFixed(6)), revoked: Boolean(k.revokedAt), createdAt: k.createdAt,
      })),
    });
  });

  r.delete('/keys/:id', auth, async (req, res) => {
    const ok = await store.revokeKey(req.auth.userId, req.params.id);
    if (!ok) throw new HttpError(404, 'Key not found', 'not_found');
    res.json({ revoked: true });
  });

  r.get('/usage', auth, async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 86_400_000);
    res.json({ days, ...(await store.usageSummary(req.auth.userId, since)) });
  });

  r.get('/usage/recent', auth, async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({ logs: await store.recentLogs(req.auth.userId, limit) });
  });

  return r;
}
