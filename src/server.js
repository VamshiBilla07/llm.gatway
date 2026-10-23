import { config } from './config.js';
import { createApp } from './app.js';
import { createStore } from './store/index.js';
import { createKV } from './infra/kv.js';
import { buildProviders } from './providers/index.js';

const store = await createStore(config);
const kv = await createKV(config);
const providers = buildProviders(config);

if (providers.size === 0) {
  console.warn('WARNING: no providers configured. Set at least one of GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OLLAMA_ENABLED=1 or MOCK_PROVIDER=1 (see .env.example).');
}

const app = createApp({ config, store, kv, providers });
const server = app.listen(config.port, () => {
  console.log(JSON.stringify({
    level: 'info', msg: 'gateway listening', port: config.port, store: store.kind, kv: kv.kind, providers: [...providers.keys()],
  }));
});

const shutdown = (sig) => {
  console.log(JSON.stringify({ level: 'info', msg: `${sig} received, shutting down` }));
  server.close(async () => {
    await store.close?.();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
