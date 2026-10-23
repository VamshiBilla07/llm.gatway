/** Shared by the in-memory store (Mongo uses an aggregation pipeline instead). */
export function summarize(logs) {
  const total = {
    requests: logs.length,
    errors: 0,
    cacheHits: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    avgLatencyMs: 0,
  };
  const byProvider = new Map();
  let latencySum = 0;
  for (const l of logs) {
    if (l.status === 'error') total.errors += 1;
    if (l.cached) total.cacheHits += 1;
    total.promptTokens += l.promptTokens || 0;
    total.completionTokens += l.completionTokens || 0;
    total.costUsd += l.costUsd || 0;
    latencySum += l.latencyMs || 0;
    const p = l.provider || 'none';
    const e = byProvider.get(p) ?? { provider: p, requests: 0, costUsd: 0, latencySum: 0 };
    e.requests += 1;
    e.costUsd += l.costUsd || 0;
    e.latencySum += l.latencyMs || 0;
    byProvider.set(p, e);
  }
  total.avgLatencyMs = logs.length ? Math.round(latencySum / logs.length) : 0;
  total.costUsd = Math.round(total.costUsd * 1e8) / 1e8;
  total.cacheHitRate = logs.length ? Number((total.cacheHits / logs.length).toFixed(3)) : 0;
  return {
    ...total,
    byProvider: [...byProvider.values()]
      .map((e) => ({
        provider: e.provider,
        requests: e.requests,
        costUsd: Math.round(e.costUsd * 1e8) / 1e8,
        avgLatencyMs: Math.round(e.latencySum / e.requests),
      }))
      .sort((a, b) => b.requests - a.requests),
  };
}
