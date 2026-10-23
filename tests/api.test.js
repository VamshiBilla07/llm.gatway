import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { MemoryKV } from '../src/infra/kv.js';
import { FakeProvider } from './helpers.js';

async function boot({ providers, env = {} } = {}) {
  const config = buildConfig({ DEFAULT_RPM: '100', DEFAULT_BUDGET_USD: '5', PROVIDER_ORDER: 'a,b', UPSTREAM_RETRIES: '0', ...env });
  const provs = new Map((providers ?? [new FakeProvider('a')]).map((p) => [p.name, p]));
  const app = createApp({ config, store: new MemoryStore(), kv: new MemoryKV(), providers: provs, quiet: true, routerOptions: { sleep: async () => {} } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { key, method = 'GET', body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const signup = async (email = 'a@b.com') => (await (await call('/v1/signup', { method: 'POST', body: { email } })).json()).apiKey;
  return { call, signup, close: () => server.close(), provs };
}

const chat = (call, key, content = 'hello', extra = {}, headers = {}) =>
  call('/v1/chat/completions', { key, method: 'POST', body: { messages: [{ role: 'user', content }], ...extra }, headers });

test('signup, auth, chat, and OpenAI-shaped response', async (t) => {
  const { call, signup, close } = await boot();
  t.after(close);

  assert.equal((await call('/v1/signup', { method: 'POST', body: { email: 'nope' } })).status, 400);
  const key = await signup();
  assert.match(key, /^gw_[0-9a-f]{48}$/);
  assert.equal((await call('/v1/signup', { method: 'POST', body: { email: 'a@b.com' } })).status, 409);

  assert.equal((await chat(call, undefined)).status, 401);
  assert.equal((await chat(call, 'gw_wrong')).status, 401);

  const res = await chat(call, key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'a');
  const json = await res.json();
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.choices[0].message.content, 'a:a-fast');
  assert.equal(json.usage.total_tokens, 150);
  assert.equal(json.gateway.cached, false);
});

test('request validation', async (t) => {
  const { call, signup, close } = await boot();
  t.after(close);
  const key = await signup();
  for (const body of [{}, { messages: [] }, { messages: [{ role: 'bot', content: 'x' }] }, { messages: [{ role: 'user', content: 'x' }], temperature: 9 }]) {
    const res = await call('/v1/chat/completions', { key, method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('exact-match cache: second identical request is a HIT and skips upstream', async (t) => {
  const a = new FakeProvider('a');
  const { call, signup, close } = await boot({ providers: [a] });
  t.after(close);
  const key = await signup();
  const r1 = await chat(call, key, 'same question');
  assert.equal(r1.headers.get('x-gateway-cache'), 'MISS');
  const r2 = await chat(call, key, 'same question');
  assert.equal(r2.headers.get('x-gateway-cache'), 'HIT');
  const j2 = await r2.json();
  assert.equal(j2.gateway.cached, true);
  assert.equal(j2.gateway.cost_usd, 0);
  assert.equal(a.calls, 1);
  const r3 = await chat(call, key, 'same question', {}, { 'x-gateway-cache': 'no-cache' });
  assert.equal(r3.headers.get('x-gateway-cache'), 'BYPASS');
  assert.equal(a.calls, 2);
});

test('fallback: failing provider is skipped, /health shows breaker state', async (t) => {
  const { call, signup, close } = await boot({
    providers: [new FakeProvider('a', [503]), new FakeProvider('b')],
    env: { BREAKER_FAILURES: '2' },
  });
  t.after(close);
  const key = await signup();
  const res = await chat(call, key, 'q1');
  assert.equal(res.headers.get('x-gateway-provider'), 'b');
  await chat(call, key, 'q2');
  const health = await (await call('/health')).json();
  assert.equal(health.providers.find((p) => p.provider === 'a').state, 'open');
});

test('per-key rate limit returns 429 with Retry-After', async (t) => {
  const { call, signup, close } = await boot({ env: { DEFAULT_RPM: '3' } });
  t.after(close);
  const key = await signup();
  for (let i = 0; i < 3; i++) assert.equal((await chat(call, key, `q${i}`)).status, 200);
  const res = await chat(call, key, 'q-extra');
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.equal(res.headers.get('x-ratelimit-remaining'), '0');
});

test('budget: requests are blocked with 402 once spend reaches the limit', async (t) => {
  // each fake request costs $0.0002 (100*1 + 50*2 per 1M tokens)
  const { call, signup, close } = await boot({ env: { DEFAULT_BUDGET_USD: '0.0003' } });
  t.after(close);
  const key = await signup();
  assert.equal((await chat(call, key, 'one')).status, 200);
  assert.equal((await chat(call, key, 'two')).status, 200);
  const res = await chat(call, key, 'three');
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error.code, 'budget_exceeded');
});

test('streaming returns OpenAI-style SSE ending with [DONE] and a usage chunk', async (t) => {
  const { call, signup, close } = await boot();
  t.after(close);
  const key = await signup();
  const res = await chat(call, key, 'stream me', { stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const raw = await res.text();
  const events = raw.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
  assert.equal(events.at(-1), '[DONE]');
  const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
  const text = parsed.map((p) => p.choices?.[0]?.delta?.content ?? '').join('');
  assert.equal(text, 'hello world');
  assert.equal(parsed.at(-1).usage.total_tokens, 150);
});

test('usage endpoints, key management and revocation', async (t) => {
  const { call, signup, close } = await boot();
  t.after(close);
  const key = await signup();
  await chat(call, key, 'u1');
  await chat(call, key, 'u1'); // cache hit
  const usage = await (await call('/v1/usage?days=1', { key })).json();
  assert.equal(usage.requests, 2);
  assert.equal(usage.cacheHits, 1);
  assert.equal(usage.cacheHitRate, 0.5);
  assert.equal(usage.byProvider[0].provider, 'a');
  const recent = await (await call('/v1/usage/recent', { key })).json();
  assert.equal(recent.logs.length, 2);

  const created = await (await call('/v1/keys', { key, method: 'POST', body: { name: 'second' } })).json();
  const list = await (await call('/v1/keys', { key })).json();
  assert.equal(list.keys.length, 2);
  assert.ok(!JSON.stringify(list).includes(created.apiKey)); // raw key never listed
  assert.equal((await call(`/v1/keys/${created.id}`, { key, method: 'DELETE' })).status, 200);
  assert.equal((await chat(call, created.apiKey)).status, 401);
});

test('invite code protects signup when configured', async (t) => {
  const { call, close } = await boot({ env: { SIGNUP_CODE: 'letmein' } });
  t.after(close);
  assert.equal((await call('/v1/signup', { method: 'POST', body: { email: 'x@y.com' } })).status, 403);
  assert.equal((await call('/v1/signup', { method: 'POST', body: { email: 'x@y.com', inviteCode: 'letmein' } })).status, 201);
});
