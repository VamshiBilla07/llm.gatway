import mongoose from 'mongoose';
import dns from 'node:dns';

const { Schema, Types } = mongoose;

const UserSchema = new Schema({ email: { type: String, required: true, unique: true } }, { timestamps: { createdAt: true, updatedAt: false } });

const ApiKeySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: String,
    prefix: String,
    hash: { type: String, required: true, unique: true },
    rpm: Number,
    budgetUsd: Number,
    spentUsd: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const RequestLogSchema = new Schema({
  requestId: String,
  userId: { type: Schema.Types.ObjectId, index: true },
  keyId: Schema.Types.ObjectId,
  provider: String,
  model: String,
  requestedModel: String,
  stream: Boolean,
  cached: Boolean,
  status: String, // 'ok' | 'error'
  statusCode: Number,
  promptTokens: Number,
  completionTokens: Number,
  costUsd: Number,
  latencyMs: Number,
  attempts: Array,
  createdAt: { type: Date, default: Date.now },
});
RequestLogSchema.index({ userId: 1, createdAt: -1 });

const clean = (doc) => {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const { _id, __v, ...rest } = o;
  const out = { id: String(_id), ...rest };
  if (out.userId) out.userId = String(out.userId);
  if (out.keyId) out.keyId = String(out.keyId);
  return out;
};

/** MongoDB Atlas (free M0) store. Logs auto-expire (TTL index) to stay inside the 512 MB free quota. */
export class MongoStore {
  constructor({ uri, logRetentionDays = 30 }) {
    this.kind = 'mongo';
    this.uri = uri;
    this.logRetentionDays = logRetentionDays;
  }

  async connect() {
    try {
      await mongoose.connect(this.uri, { serverSelectionTimeoutMS: 8000 });
    } catch (err) {
      if (err.code === 'ECONNREFUSED' && err.syscall === 'querySrv') {
        dns.setServers(['8.8.8.8', '1.1.1.1']);
        await mongoose.connect(this.uri, { serverSelectionTimeoutMS: 8000 });
      } else {
        throw err;
      }
    }
    this.User = mongoose.models.User ?? mongoose.model('User', UserSchema);
    this.ApiKey = mongoose.models.ApiKey ?? mongoose.model('ApiKey', ApiKeySchema);
    this.Log = mongoose.models.RequestLog ?? mongoose.model('RequestLog', RequestLogSchema);
    // TTL index: MongoDB deletes old logs automatically
    await this.Log.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: this.logRetentionDays * 86400, name: 'ttl_createdAt' }).catch(() => {});
    await Promise.all([this.User.init(), this.ApiKey.init(), this.Log.init().catch(() => {})]);
  }

  async close() {
    await mongoose.disconnect();
  }

  async createUser({ email }) {
    return clean(await this.User.create({ email }));
  }

  async findUserByEmail(email) {
    return clean(await this.User.findOne({ email }));
  }

  async createKey(data) {
    return clean(await this.ApiKey.create({ ...data, userId: new Types.ObjectId(data.userId) }));
  }

  async findKeyByHash(hash) {
    return clean(await this.ApiKey.findOne({ hash }));
  }

  async listKeys(userId) {
    const docs = await this.ApiKey.find({ userId: new Types.ObjectId(userId) }).select('-hash').sort({ createdAt: -1 });
    return docs.map(clean);
  }

  async revokeKey(userId, keyId) {
    if (!Types.ObjectId.isValid(keyId)) return false;
    const r = await this.ApiKey.updateOne({ _id: keyId, userId: new Types.ObjectId(userId) }, { revokedAt: new Date() });
    return r.matchedCount > 0;
  }

  async addSpend(keyId, usd) {
    await this.ApiKey.updateOne({ _id: keyId }, { $inc: { spentUsd: usd } }); // atomic
  }

  async logRequest(entry) {
    await this.Log.create({
      ...entry,
      userId: new Types.ObjectId(entry.userId),
      keyId: new Types.ObjectId(entry.keyId),
    });
  }

  async usageSummary(userId, since) {
    const $match = { userId: new Types.ObjectId(userId), createdAt: { $gte: since } };
    const [totals] = await this.Log.aggregate([
      { $match },
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
          cacheHits: { $sum: { $cond: ['$cached', 1, 0] } },
          promptTokens: { $sum: '$promptTokens' },
          completionTokens: { $sum: '$completionTokens' },
          costUsd: { $sum: '$costUsd' },
          avgLatencyMs: { $avg: '$latencyMs' },
        },
      },
    ]);
    const byProvider = await this.Log.aggregate([
      { $match },
      { $group: { _id: '$provider', requests: { $sum: 1 }, costUsd: { $sum: '$costUsd' }, avgLatencyMs: { $avg: '$latencyMs' } } },
      { $sort: { requests: -1 } },
    ]);
    const t = totals ?? { requests: 0, errors: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, avgLatencyMs: 0 };
    return {
      requests: t.requests,
      errors: t.errors,
      cacheHits: t.cacheHits,
      cacheHitRate: t.requests ? Number((t.cacheHits / t.requests).toFixed(3)) : 0,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      costUsd: Math.round(t.costUsd * 1e8) / 1e8,
      avgLatencyMs: Math.round(t.avgLatencyMs || 0),
      byProvider: byProvider.map((p) => ({
        provider: p._id ?? 'none',
        requests: p.requests,
        costUsd: Math.round(p.costUsd * 1e8) / 1e8,
        avgLatencyMs: Math.round(p.avgLatencyMs || 0),
      })),
    };
  }

  async recentLogs(userId, limit) {
    const docs = await this.Log.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).limit(limit);
    return docs.map(clean);
  }
}
