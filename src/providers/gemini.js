import { postJson } from './http.js';
import { sseData } from '../utils/sse.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const FINISH = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter' };

/** Adapter for Google's Gemini API (different request/response shape from OpenAI). */
export class GeminiProvider {
  constructor({ name = 'gemini', apiKey, models }) {
    this.name = name;
    this.apiKey = apiKey;
    this.models = models;
  }

  #headers() {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  #body(req) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const gen = {};
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    if (req.maxTokens !== undefined) gen.maxOutputTokens = req.maxTokens;
    if (Object.keys(gen).length) body.generationConfig = gen;
    return body;
  }

  static #text(json) {
    return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }

  static #usage(json) {
    const u = json.usageMetadata;
    return u ? { promptTokens: u.promptTokenCount, completionTokens: u.candidatesTokenCount } : undefined;
  }

  async chat(req) {
    const res = await postJson(this.name, `${BASE}/${req.model}:generateContent`, {
      headers: this.#headers(),
      body: this.#body(req),
      signal: req.signal,
    });
    const json = await res.json();
    const reason = json.candidates?.[0]?.finishReason;
    return {
      content: GeminiProvider.#text(json),
      finishReason: FINISH[reason] ?? 'stop',
      usage: GeminiProvider.#usage(json) ?? {},
    };
  }

  async *stream(req) {
    const res = await postJson(this.name, `${BASE}/${req.model}:streamGenerateContent?alt=sse`, {
      headers: this.#headers(),
      body: this.#body(req),
      signal: req.signal,
    });
    for await (const data of sseData(res.body)) {
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const out = {};
      const text = GeminiProvider.#text(json);
      if (text) out.delta = text;
      const reason = json.candidates?.[0]?.finishReason;
      if (reason) out.finishReason = FINISH[reason] ?? 'stop';
      const usage = GeminiProvider.#usage(json);
      if (usage) out.usage = usage;
      if (Object.keys(out).length) yield out;
    }
  }
}
