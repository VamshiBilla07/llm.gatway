import { ProviderError, classifyStatus } from '../utils/errors.js';

/** fetch wrapper that turns network errors / bad statuses into ProviderError. */
export async function postJson(provider, url, { headers, body, signal }) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ProviderError(timedOut ? 'upstream timeout' : `network error: ${err.message}`, {
      status: timedOut ? 504 : 0,
      retryable: true,
      failover: true,
      provider,
    });
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(`upstream ${res.status}: ${text}`, { status: res.status, provider, ...classifyStatus(res.status) });
  }
  return res;
}
