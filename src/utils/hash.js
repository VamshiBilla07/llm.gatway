import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newRequestId = () => `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Returns { key, prefix, hash }. The raw key is shown to the user once; only the hash is stored. */
export function generateApiKey() {
  const key = `gw_${randomBytes(24).toString('hex')}`;
  return { key, prefix: key.slice(0, 10), hash: sha256(key) };
}
