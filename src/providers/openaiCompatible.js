import { postJson } from './http.js';
import { sseData } from '../utils/sse.js';

/** Works for Groq, OpenRouter, Ollama, and any other OpenAI-style /chat/completions API. */
export class OpenAICompatibleProvider {
  constructor({ name, baseUrl, apiKey, models }) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.models = models;
  }

  #headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  #body(req, stream) {
    const body = { model: req.model, messages: req.messages, stream };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async chat(req) {
    const res = await postJson(this.name, `${this.baseUrl}/chat/completions`, {
      headers: this.#headers(),
      body: this.#body(req, false),
      signal: req.signal,
    });
    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
    };
  }

  async *stream(req) {
    const res = await postJson(this.name, `${this.baseUrl}/chat/completions`, {
      headers: this.#headers(),
      body: this.#body(req, true),
      signal: req.signal,
    });
    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const choice = json.choices?.[0];
      const out = {};
      if (choice?.delta?.content) out.delta = choice.delta.content;
      if (choice?.finish_reason) out.finishReason = choice.finish_reason;
      if (json.usage) out.usage = { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens };
      if (Object.keys(out).length) yield out;
    }
  }
}
