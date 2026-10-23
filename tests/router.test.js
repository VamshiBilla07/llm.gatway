import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, pickTier } from '../src/services/router.js';
import { HttpError } from '../src/utils/errors.js';
import { FakeProvider } from './helpers.js';

const mk = (providers, { retries = 1, threshold = 3 } = {}) =>
  new Router({
    providers: new Map(providers.map((p) => [p.name, p])),
    order: providers.map((p) => p.name),
    upstream: { timeoutMs: 1000, retries },
    breakerConfig: { failureThreshold: threshold, cooldownMs: 60000 },
    sleep: async () => {},
  });

const msgs = [{ role: 'user', content: 'hi' }];

test('pickTier: short chat -> fast, code/long -> smart', () => {
  assert.equal(pickTier(msgs), 'fast');
  assert.equal(pickTier([{ role: 'user', content: 'please debug this function' }]), 'smart');
  assert.equal(pickTier([{ role: 'user', content: 'x'.repeat(2000) }]), 'smart');
});

test('plan: pinned provider/model disables fallback', () => {
  const r = mk([new FakeProvider('a'), new FakeProvider('b')]);
  const plan = r.plan('b/custom-model', msgs);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].model.id, 'custom-model');
});

test('retries the same provider once on 503, then succeeds', async () => {
  const a = new FakeProvider('a', [503, 'ok']);
  const r = mk([a]);
  const out = await r.chat(r.plan('auto', msgs), { messages: msgs });
  assert.equal(out.provider, 'a');
  assert.equal(a.calls, 2);
});

test('falls back to next provider when first keeps failing', async () => {
  const a = new FakeProvider('a', [500]);
  const b = new FakeProvider('b', ['ok']);
  const r = mk([a, b]);
  const out = await r.chat(r.plan('auto', msgs), { messages: msgs });
  assert.equal(out.provider, 'b');
  assert.equal(out.attempts.at(-1).ok, true);
  assert.equal(a.calls, 2); // original + 1 retry
});

test('400 from upstream is NOT retried or failed over', async () => {
  const a = new FakeProvider('a', [400]);
  const b = new FakeProvider('b', ['ok']);
  const r = mk([a, b]);
  await assert.rejects(r.chat(r.plan('auto', msgs), { messages: msgs }), (e) => e instanceof HttpError && e.status === 400);
  assert.equal(b.calls, 0);
  assert.equal(a.calls, 1);
});

test('all providers failing -> 502 with attempts', async () => {
  const r = mk([new FakeProvider('a', [500]), new FakeProvider('b', ['net'])]);
  await assert.rejects(r.chat(r.plan('auto', msgs), { messages: msgs }), (e) => e.status === 502 && e.extra.attempts.length >= 2);
});

test('circuit opens after repeated failures and provider is skipped', async () => {
  const a = new FakeProvider('a', [500]);
  const b = new FakeProvider('b', ['ok']);
  const r = mk([a, b], { retries: 0, threshold: 2 });
  await r.chat(r.plan('auto', msgs), { messages: msgs });
  await r.chat(r.plan('auto', msgs), { messages: msgs });
  assert.equal(r.breaker('a').state, 'open');
  const before = a.calls;
  const out = await r.chat(r.plan('auto', msgs), { messages: msgs });
  assert.equal(out.provider, 'b');
  assert.equal(a.calls, before); // skipped entirely
});

test('streaming falls back before first chunk', async () => {
  const r = mk([new FakeProvider('a', [500]), new FakeProvider('b', ['ok'])]);
  const { iterator, provider } = await r.stream(r.plan('auto', msgs), { messages: msgs });
  assert.equal(provider, 'b');
  const parts = [];
  for await (const c of iterator) if (c.delta) parts.push(c.delta);
  assert.equal(parts.join(''), 'hello world');
});

test('no providers configured -> 503', async () => {
  const r = mk([]);
  await assert.rejects(r.chat(r.plan('auto', msgs), { messages: msgs }), (e) => e.status === 503);
});
