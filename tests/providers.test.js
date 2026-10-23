import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { ProviderError } from '../src/utils/errors.js';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const sseResponse = (events) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${e}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const models = { fast: { id: 'm' }, smart: { id: 'm' } };

test('openai-compatible: non-stream normalizes response and sends bearer key', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return Response.json({ choices: [{ message: { content: 'hey' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  };
  const p = new OpenAICompatibleProvider({ name: 'groq', baseUrl: 'https://x/v1/', apiKey: 'k', models });
  const out = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'yo' }], temperature: 0.2 });
  assert.equal(out.content, 'hey');
  assert.deepEqual(out.usage, { promptTokens: 3, completionTokens: 2 });
  assert.equal(seen.url, 'https://x/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.equal(JSON.parse(seen.init.body).temperature, 0.2);
});

test('openai-compatible: stream parses SSE deltas, usage and DONE', async () => {
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    '[DONE]',
  ]);
  const p = new OpenAICompatibleProvider({ name: 'groq', baseUrl: 'https://x/v1', apiKey: 'k', models });
  let text = ''; let usage;
  for await (const c of p.stream({ model: 'm', messages: [] })) { if (c.delta) text += c.delta; if (c.usage) usage = c.usage; }
  assert.equal(text, 'Hello');
  assert.deepEqual(usage, { promptTokens: 5, completionTokens: 2 });
});

test('upstream status codes map to retry/failover flags', async () => {
  const p = new OpenAICompatibleProvider({ name: 'groq', baseUrl: 'https://x/v1', apiKey: 'k', models });
  for (const [status, retryable, failover] of [[429, true, true], [503, true, true], [401, false, true], [400, false, false]]) {
    globalThis.fetch = async () => new Response('nope', { status });
    await assert.rejects(p.chat({ model: 'm', messages: [] }), (e) => e instanceof ProviderError && e.retryable === retryable && e.failover === failover);
  }
});

test('network failure -> retryable failover error', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const p = new OpenAICompatibleProvider({ name: 'ollama', baseUrl: 'http://localhost:1/v1', models });
  await assert.rejects(p.chat({ model: 'm', messages: [] }), (e) => e.retryable && e.failover);
});

test('gemini: maps roles/system prompt and parses response + usage', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'Hi ' }, { text: 'there' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
    });
  };
  const p = new GeminiProvider({ apiKey: 'g', models });
  const out = await p.chat({
    model: 'gemini-x', maxTokens: 50,
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
  });
  const body = JSON.parse(seen.init.body);
  assert.equal(seen.init.headers['x-goog-api-key'], 'g');
  assert.match(seen.url, /models\/gemini-x:generateContent$/);
  assert.equal(body.systemInstruction.parts[0].text, 'be brief');
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(body.generationConfig.maxOutputTokens, 50);
  assert.equal(out.content, 'Hi there');
  assert.equal(out.finishReason, 'length');
  assert.deepEqual(out.usage, { promptTokens: 7, completionTokens: 4 });
});

test('gemini: stream', async () => {
  globalThis.fetch = async () => sseResponse([
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A' }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'B' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } }),
  ]);
  const p = new GeminiProvider({ apiKey: 'g', models });
  let text = '';
  for await (const c of p.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) if (c.delta) text += c.delta;
  assert.equal(text, 'AB');
});
