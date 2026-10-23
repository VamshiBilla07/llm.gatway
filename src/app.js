import express from 'express';
import { newRequestId } from './utils/hash.js';
import { Router as ExpressRouter } from 'express';
import { Router } from './services/router.js';
import { ResponseCache } from './services/cache.js';
import { accountRoutes } from './routes/account.js';
import { chatRoutes } from './routes/chat.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

/**
 * App factory: everything is injected, so tests can pass fake providers and an in-memory store.
 */
export function createApp({ config, store, kv, providers, quiet = false, routerOptions = {} }) {
  const app = express();
  app.set('trust proxy', 1); // correct client IP behind Render/Railway proxies
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.id = newRequestId();
    res.set('x-request-id', req.id);
    res.set('x-content-type-options', 'nosniff');
    if (!quiet) {
      const t0 = Date.now();
      res.on('finish', () => {
        console.log(JSON.stringify({ level: 'info', requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
      });
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  const router = new Router({
    providers,
    order: config.providerOrder,
    upstream: config.upstream,
    breakerConfig: config.breaker,
    ...routerOptions,
  });
  const cache = new ResponseCache(kv, config.cache.ttlSeconds);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      store: store.kind,
      kv: kv.kind,
      providers: router.status(),
    });
  });

  const v1 = ExpressRouter();
  v1.use(accountRoutes({ store, kv, config }));
  v1.use(chatRoutes({ store, kv, router, cache }));
  v1.get('/models', (req, res) => {
    res.json({
      note: 'Use model "auto" (default), "fast", "smart", or pin one with "<provider>/<model-id>" (pinned = no fallback).',
      providers: [...providers.values()].map((p) => ({ provider: p.name, fast: p.models.fast.id, smart: p.models.smart.id })),
      fallbackOrder: config.providerOrder.filter((n) => providers.has(n)),
    });
  });
  app.use('/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  app.locals.router = router;
  return app;
}
