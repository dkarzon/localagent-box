import { stripProviderModelPrefix } from './llm-provider';
import type { ModelTokenCost, ModelTokenCosts } from '../types';

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Resolve rates for a model id: exact key first, then provider-prefix-insensitive
 * match, then the `*` wildcard fallback.
 */
export function resolveModelTokenCost(costs: ModelTokenCosts, modelId: string): ModelTokenCost | null {
  const raw = modelId.trim();
  if (!raw) return null;
  if (costs[raw]) return costs[raw];
  const bare = stripProviderModelPrefix(raw);
  for (const [key, cost] of Object.entries(costs)) {
    if (key === '*') continue;
    if (stripProviderModelPrefix(key) === bare) return cost;
  }
  return costs['*'] ?? null;
}

export function hasModelTokenCost(cost: ModelTokenCost | null): boolean {
  return Boolean(cost && Object.values(cost).some((rate) => typeof rate === 'number' && rate > 0));
}

/** Cost in USD for one message's token counts at the model's configured rates. */
export function computeModelCost(
  cost: ModelTokenCost,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const rate = (value?: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return (
    (rate(cost.input) * usage.input +
      rate(cost.output) * usage.output +
      rate(cost.cacheRead) * usage.cacheRead +
      rate(cost.cacheWrite) * usage.cacheWrite) /
    TOKENS_PER_MILLION
  );
}
