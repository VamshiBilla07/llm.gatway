import { HttpError } from '../utils/errors.js';
import { sha256 } from '../utils/hash.js';

/** Accepts `Authorization: Bearer gw_...` or `x-api-key: gw_...`. Only the SHA-256 hash is ever stored/compared. */
export function requireAuth(store) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('x-api-key');
    if (!raw) throw new HttpError(401, 'Missing API key. Send "Authorization: Bearer <key>".', 'missing_api_key');
    const key = await store.findKeyByHash(sha256(raw));
    if (!key || key.revokedAt) throw new HttpError(401, 'Invalid or revoked API key', 'invalid_api_key');
    req.auth = { key, userId: key.userId };
    next();
  };
}
