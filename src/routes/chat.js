import { Router } from 'express';
import { HttpError } from '../utils/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { ResponseCache } from '../services/cache.js';
import { computeCost, estimatePromptTokens, estimateTokens } from '../services/cost.js';

const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_CHARS = 60_000;

export function validateChat(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required', 'invalid_request');
  const { messages, model, temperature, max_tokens: maxTokens, stream } = body;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
    throw new HttpError(400, '"messages" must be an array of 1-50 items', 'invalid_request');
  }
  let chars = 0;
  for (const m of messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string' || !m.content.length) {
      throw new HttpError(400, 'Each message needs a role (system|user|assistant) and non-empty string content', 'invalid_request');
    }
    chars += m.content.length;
  }
  if (chars > MAX_CHARS) throw new HttpError(413, `Prompt too long (max ${MAX_CHARS} characters)`, 'too_large');
  if (model !== undefined && typeof model !== 'string') throw new HttpError(400, '"model" must be a string', 'invalid_request');
  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
    throw new HttpError(400, '"temperature" must be a number between 0 and 2', 'invalid_request');
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192)) {
    throw new HttpError(400, '"max_tokens" must be an integer between 1 and 8192', 'invalid_request');
  }
  return {
    messages: messages.map(({ role, content }) => ({ role, content })),
    model: model || 'auto',
    temperature,
    maxTokens,
    stream: stream === true,
  };
}

export function chatRoutes({ store, kv, router, cache }) {
  const r = Router();

  const safeLog = async (entry) => {
    try {
      await store.logRequest(entry);
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: 'failed to write request log', error: err.message }));
    }
  };

  const chunk = (id, created, model, delta, finish = null) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  r.post('/chat/completions', requireAuth(store), rateLimit(kv), async (req, res) => {
    const t0 = Date.now();
    const body = validateChat(req.body);
    const { key, userId } = req.auth;

    if (key.spentUsd >= key.budgetUsd) {
      throw new HttpError(402, `Budget exhausted ($${key.budgetUsd.toFixed(2)}). Create a new key or raise the budget.`, 'budget_exceeded');
    }

    const plan = router.plan(body.model, body.messages);
    const base = { requestId: req.id, userId, keyId: key.id, requestedModel: body.model, stream: body.stream };
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const upstreamReq = { messages: body.messages, temperature: body.temperature, maxTokens: body.maxTokens, signal: ac.signal };
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${req.id}`;

    const fail = async (err, extra = {}) => {
      await safeLog({
        ...base, provider: null, model: null, cached: false, status: 'error', statusCode: err.status ?? 500,
        promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: Date.now() - t0, attempts: err.extra?.attempts ?? [], ...extra,
      });
    };

    // ---------------- streaming ----------------
    if (body.stream) {
      let started;
      try {
        started = await router.stream(plan, upstreamReq);
      } catch (err) {
        await fail(err);
        throw err;
      }
      const { iterator, provider, model, attempts } = started;
      res.status(200).set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-gateway-provider': provider,
        'x-gateway-model': model.id,
        'x-gateway-cache': 'BYPASS',
      });
      res.flushHeaders();

      let text = '';
      let usage = {};
      let finish = 'stop';
      let sentRole = false;
      let status = 'ok';
      let statusCode = 200;
      try {
        for await (const c of iterator) {
          if (c.delta) {
            text += c.delta;
            const delta = sentRole ? { content: c.delta } : { role: 'assistant', content: c.delta };
            sentRole = true;
            res.write(`data: ${JSON.stringify(chunk(completionId, created, model.id, delta))}\n\n`);
          }
          if (c.finishReason) finish = c.finishReason;
          if (c.usage) usage = { ...usage, ...Object.fromEntries(Object.entries(c.usage).filter(([, v]) => v != null)) };
        }
        res.write(`data: ${JSON.stringify(chunk(completionId, created, model.id, {}, finish))}\n\n`);
      } catch (err) {
        status = 'error';
        statusCode = ac.signal.aborted ? 499 : 502;
        if (!ac.signal.aborted) {
          res.write(`data: ${JSON.stringify({ error: { message: 'Upstream stream failed', code: 'stream_error', request_id: req.id } })}\n\n`);
        }
      }
      const promptTokens = usage.promptTokens ?? estimatePromptTokens(body.messages);
      const completionTokens = usage.completionTokens ?? estimateTokens(text);
      const costUsd = computeCost(model, { promptTokens, completionTokens });
      const latencyMs = Date.now() - t0;
      res.write(`data: ${JSON.stringify({
        id: completionId, object: 'chat.completion.chunk', created, model: model.id, choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        gateway: { provider, cached: false, latency_ms: latencyMs, cost_usd: costUsd },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      await safeLog({ ...base, provider, model: model.id, cached: false, status, statusCode, promptTokens, completionTokens, costUsd, latencyMs, attempts });
      if (costUsd) await store.addSpend(key.id, costUsd).catch(() => {});
      return;
    }

    // ---------------- non-streaming ----------------
    const skipCache = (req.get('x-gateway-cache') || '').toLowerCase() === 'no-cache';
    const cacheKey = ResponseCache.keyFor({ model: body.model, messages: body.messages, temperature: body.temperature, maxTokens: body.maxTokens });

    if (!skipCache) {
      const hit = await cache.get(cacheKey);
      if (hit) {
        const latencyMs = Date.now() - t0;
        await safeLog({
          ...base, provider: hit.gateway.provider, model: hit.model, cached: true, status: 'ok', statusCode: 200,
          promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs, attempts: [],
        });
        res.set({ 'x-gateway-provider': hit.gateway.provider, 'x-gateway-model': hit.model, 'x-gateway-cache': 'HIT' });
        return res.json({ ...hit, id: completionId, created, gateway: { ...hit.gateway, cached: true, latency_ms: latencyMs, cost_usd: 0 } });
      }
    }

    let out;
    try {
      out = await router.chat(plan, upstreamReq);
    } catch (err) {
      await fail(err);
      throw err;
    }
    const { result, provider, model, attempts } = out;
    const promptTokens = result.usage?.promptTokens ?? estimatePromptTokens(body.messages);
    const completionTokens = result.usage?.completionTokens ?? estimateTokens(result.content);
    const costUsd = computeCost(model, { promptTokens, completionTokens });
    const latencyMs = Date.now() - t0;

    const payload = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: model.id,
      choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: result.finishReason }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      gateway: { provider, cached: false, latency_ms: latencyMs, cost_usd: costUsd, attempts: attempts.length },
    };

    await safeLog({ ...base, provider, model: model.id, cached: false, status: 'ok', statusCode: 200, promptTokens, completionTokens, costUsd, latencyMs, attempts });
    if (costUsd) await store.addSpend(key.id, costUsd).catch(() => {});
    if (!skipCache) await cache.set(cacheKey, payload);

    res.set({ 'x-gateway-provider': provider, 'x-gateway-model': model.id, 'x-gateway-cache': skipCache ? 'BYPASS' : 'MISS' });
    res.json(payload);
  });

  return r;
}
