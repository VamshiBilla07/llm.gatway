/** Rough token estimate (~4 chars/token) used only when a provider doesn't report usage. */
export const estimateTokens = (text) => Math.ceil((text ?? '').length / 4);

export function estimatePromptTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

/** price = { in, out } in USD per 1M tokens. */
export function computeCost(price, { promptTokens = 0, completionTokens = 0 }) {
  if (!price) return 0;
  const usd = (promptTokens * (price.in ?? 0) + completionTokens * (price.out ?? 0)) / 1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}
