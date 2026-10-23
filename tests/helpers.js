import { ProviderError, classifyStatus } from '../src/utils/errors.js';

export const models = (tag) => ({
  fast: { id: `${tag}-fast`, in: 1, out: 2 },
  smart: { id: `${tag}-smart`, in: 1, out: 2 },
});

/** Scriptable fake provider. `script` is an array of behaviours consumed per call: 'ok' | status number | 'net'. */
export class FakeProvider {
  constructor(name, script = ['ok']) {
    this.name = name;
    this.models = models(name);
    this.script = script;
    this.calls = 0;
  }

  #next() {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step === 'ok') return;
    if (step === 'net') throw new ProviderError('network error', { status: 0, retryable: true, failover: true, provider: this.name });
    throw new ProviderError(`upstream ${step}`, { status: step, provider: this.name, ...classifyStatus(step) });
  }

  async chat(req) {
    this.#next();
    return { content: `${this.name}:${req.model}`, finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 50 } };
  }

  async *stream(req) {
    this.#next();
    yield { delta: 'hello ' };
    yield { delta: 'world' };
    yield { finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 50 } };
  }
}
