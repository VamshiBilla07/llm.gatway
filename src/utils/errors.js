/** Error thrown by provider adapters. Tells the router what to do next. */
export class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false, failover = false, provider = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable; // try the same provider again
    this.failover = failover; // try the next provider
    this.provider = provider;
  }
}

/** Map an upstream HTTP status to retry/failover behaviour. */
export function classifyStatus(status) {
  const retryable = status === 408 || status === 429 || status >= 500;
  // 401/403/404 usually mean our key/model config for that provider is bad: skip it, don't retry.
  const failover = retryable || status === 401 || status === 403 || status === 404;
  return { retryable, failover };
}

/** Error returned to API clients as JSON. */
export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
