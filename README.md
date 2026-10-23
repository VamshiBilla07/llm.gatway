# LLM Gateway

A production-style backend that sits in front of multiple LLM providers and gives your apps **one OpenAI-compatible API** with auth, routing, automatic fallback, caching, rate limiting, streaming, budgets and usage analytics.

Built with **Node.js + Express**. Runs entirely on **free tiers** (Groq, Gemini, OpenRouter free models, local Ollama, MongoDB Atlas M0, Upstash Redis).

```
Client ──► Gateway ──► [ auth → rate limit → budget check → cache ]
                          │
                          ▼
                       Router ── tier heuristic (fast / smart) ── provider order
                          │        retry + backoff · circuit breaker · fallback
                          ▼
              Groq │ Gemini │ OpenRouter │ Ollama   (adapters share one interface)
                          │
                          ▼
              logs (tokens, latency, cost) ► MongoDB   ·   cache + limits ► Redis
```

## Features

| Feature | How it works |
|---|---|
| OpenAI-compatible API | `POST /v1/chat/completions`, works with the OpenAI SDKs by changing `baseURL` |
| Multi-provider adapters | Groq / OpenRouter / Ollama (OpenAI-style) + Gemini (own format), one `chat()` / `stream()` interface |
| Smart routing | `model: "auto"` picks a `fast` or `smart` tier from prompt length and content; or pin `"groq/llama-3.1-8b-instant"` |
| Reliability | Retry with exponential backoff, per-provider circuit breaker (closed, open, half-open), ordered fallback |
| Streaming | SSE passthrough; fallback happens before the first token |
| Caching | Exact-match response cache (memory, or Redis when configured) with TTL |
| Rate limiting | Per-API-key requests/minute, standard `X-RateLimit-*` + `Retry-After` headers |
| Budgets | Per-key spend limit using reference prices; returns `402` when exhausted |
| Auth | Hashed API keys (SHA-256), create / list / revoke, shown once |
| Analytics | `/v1/usage` (tokens, cost, latency, cache-hit rate, per-provider) and `/v1/usage/recent` |
| Storage | MongoDB Atlas, or in-memory with zero setup. Logs auto-expire (TTL index) to stay within the free quota |

## Quick start (no API keys needed)

```bash
npm install
cp .env.example .env
# in .env set MOCK_PROVIDER=1
npm start
```

```bash
# 1. create an account + key
curl -s -X POST localhost:3000/v1/signup -H 'content-type: application/json' -d '{"email":"you@example.com"}'

# 2. chat
curl -s localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Explain circuit breakers in one line"}]}'

# 3. stream
curl -N localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"Hello"}]}'

# 4. usage
curl -s localhost:3000/v1/usage -H "authorization: Bearer $GW_KEY"
```

Using the OpenAI SDK:

```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:3000/v1', apiKey: process.env.GW_KEY });
const r = await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
```

## Free setup for real providers

You only need **one** to start. Add more to get fallback.

1. **Groq**: key at console.groq.com, set `GROQ_API_KEY`
2. **Gemini**: key at aistudio.google.com, set `GEMINI_API_KEY`
3. **OpenRouter**: key at openrouter.ai, set `OPENROUTER_API_KEY` (use models ending in `:free`)
4. **Ollama (local)**: install Ollama, `ollama pull llama3.2:3b`, set `OLLAMA_ENABLED=1`
5. **MongoDB Atlas**: free M0 cluster, set `MONGODB_URI`
6. **Upstash Redis**: free database, set `REDIS_URL` (the `rediss://` URL)

> Free-tier model names and limits change often (Gemini especially). If a provider starts returning 404/429,
> check its docs and override the `*_MODEL_FAST` / `*_MODEL_SMART` values in `.env`. The gateway's fallback
> keeps serving from other providers in the meantime.

## API summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/signup` | none | `{email, inviteCode?}`, returns your API key once |
| POST | `/v1/chat/completions` | key | `{messages, model?, temperature?, max_tokens?, stream?}` |
| GET | `/v1/models` | none | providers, tiers, fallback order |
| POST/GET/DELETE | `/v1/keys` | key | create / list / revoke keys |
| GET | `/v1/usage?days=7` | key | aggregate analytics |
| GET | `/v1/usage/recent?limit=20` | key | latest request logs |
| GET | `/health` | none | store, cache, and per-provider circuit state |

Response headers on chat: `x-gateway-provider`, `x-gateway-model`, `x-gateway-cache` (`HIT` / `MISS` / `BYPASS`), `x-request-id`.
Send `x-gateway-cache: no-cache` to skip the cache.

## Tests

```bash
npm test
```

26 tests cover the circuit breaker, retry/fallback logic, provider adapters (mocked `fetch`), and the full HTTP API
(auth, validation, cache, rate limit, budget, streaming, key revocation).

## Deploy for free

- **Render / Railway / Fly.io** free plans: set the env vars from `.env.example`; start command `npm start`
  (or use the included `Dockerfile`). Free web services usually sleep when idle, so the first request can be slow.
- Set `SIGNUP_CODE` on any public deployment, otherwise strangers can sign up and use your free provider quotas.

## Design decisions worth explaining in interviews

- **Fail open on infrastructure** (cache / rate-limit store down) but **fail closed on auth**.
- **400s are never retried or failed over** (the request is bad everywhere); 429/5xx/timeouts are.
- **Fallback stops at the first streamed byte**, because the client has already received data.
- **Only key hashes are stored**; raw keys are shown once.
- **Atomic spend updates** (`$inc`) so concurrent requests can't overspend by racing.
- **Fixed-window** rate limiting is simple and cheap; a sliding window or token bucket is the natural upgrade.

## Roadmap (good next commits)

1. Semantic cache: embed prompts, return cached answers above a cosine-similarity threshold, measure savings
2. React dashboard for usage, provider health and cost charts
3. Load test with `autocannon` / `k6` and put the numbers in this README
4. Per-key model allow-lists and prompt-injection checks
5. Prometheus `/metrics` endpoint and Grafana Cloud free dashboards
