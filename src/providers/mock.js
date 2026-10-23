const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Offline fake provider for demos and tests. Needs no API key. */
export class MockProvider {
  constructor({ name = 'mock', models, delayMs = 20 } = {}) {
    this.name = name;
    this.delayMs = delayMs;
    this.models = models ?? { fast: { id: 'mock-fast', in: 0, out: 0 }, smart: { id: 'mock-smart', in: 0, out: 0 } };
  }

  #reply(req) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return `[${req.model}] You said: ${last}`;
  }

  async chat(req) {
    await sleep(this.delayMs);
    const content = this.#reply(req);
    return { content, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: Math.ceil(content.length / 4) } };
  }

  async *stream(req) {
    const words = this.#reply(req).split(' ');
    for (const w of words) {
      await sleep(this.delayMs);
      yield { delta: `${w} ` };
    }
    yield { finishReason: 'stop', usage: { promptTokens: 10, completionTokens: words.length } };
  }
}
