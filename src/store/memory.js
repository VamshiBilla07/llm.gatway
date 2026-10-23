import { randomUUID } from 'node:crypto';
import { summarize } from './summary.js';

/** Zero-setup store. Great for dev and tests; data is lost on restart. */
export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.users = new Map();
    this.keys = new Map();
    this.logs = [];
  }

  async createUser({ email }) {
    const user = { id: randomUUID(), email, createdAt: new Date() };
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async createKey({ userId, name, prefix, hash, rpm, budgetUsd }) {
    const key = { id: randomUUID(), userId, name, prefix, hash, rpm, budgetUsd, spentUsd: 0, revokedAt: null, createdAt: new Date() };
    this.keys.set(key.id, key);
    return key;
  }

  async findKeyByHash(hash) {
    return [...this.keys.values()].find((k) => k.hash === hash) ?? null;
  }

  async listKeys(userId) {
    return [...this.keys.values()].filter((k) => k.userId === userId).map(({ hash, ...rest }) => rest);
  }

  async revokeKey(userId, keyId) {
    const k = this.keys.get(keyId);
    if (!k || k.userId !== userId) return false;
    k.revokedAt = new Date();
    return true;
  }

  async addSpend(keyId, usd) {
    const k = this.keys.get(keyId);
    if (k) k.spentUsd += usd;
  }

  async logRequest(entry) {
    this.logs.push({ ...entry, createdAt: new Date() });
    if (this.logs.length > 5000) this.logs.shift();
  }

  async usageSummary(userId, since) {
    return summarize(this.logs.filter((l) => l.userId === userId && l.createdAt >= since));
  }

  async recentLogs(userId, limit) {
    return this.logs.filter((l) => l.userId === userId).slice(-limit).reverse();
  }
}
