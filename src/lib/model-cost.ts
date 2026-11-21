import { stripProviderModelPrefix } from './llm-provider';
import type { ModelTokenCost, ModelTokenCosts } from '../types';

const TOKENS_PER_MILLION = 1_000_000;
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** A usable rate: finite and non-negative, otherwise 0. */
export function normalizeRate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Keep only finite, non-negative numeric rates for the known categories, keyed by
 * non-empty model ids. Anything else (strings, negatives, non-objects) is dropped.
 */
export function sanitizeModelTokenCosts(raw: unknown): ModelTokenCosts {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: ModelTokenCosts = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const model = key.trim();
    if (!model || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry: ModelTokenCost = {};
    for (const rateKey of RATE_KEYS) {
      const rate = (value as Record<string, unknown>)[rateKey];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) entry[rateKey] = rate;
    }
    out[model] = entry;
  }
  return out;
}

/**
 * Resolve rates for a model id: exact key first, then provider-prefix-insensitive
 * match. Models without an entry have no cost.
 */
export function resolveModelTokenCost(costs: ModelTokenCosts, modelId: string): ModelTokenCost | null {
  const raw = modelId.trim();
  if (!raw) return null;
  if (costs[raw]) return costs[raw];
  const bare = stripProviderModelPrefix(raw);
  for (const [key, cost] of Object.entries(costs)) {
    if (stripProviderModelPrefix(key) === bare) return cost;
  }
  return null;
}

export function hasModelTokenCost(cost: ModelTokenCost | null): boolean {
  return Boolean(cost && RATE_KEYS.some((key) => normalizeRate(cost[key]) > 0));
}

/**
 * Cost in USD for one message's token counts at the model's configured rates.
 * Reasoning tokens are billed at the output rate.
 */
export function computeModelCost(
  cost: ModelTokenCost,
  usage: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number },
): number {
  return (
    (normalizeRate(cost.input) * usage.input +
      normalizeRate(cost.output) * (usage.output + (usage.reasoning ?? 0)) +
      normalizeRate(cost.cacheRead) * usage.cacheRead +
      normalizeRate(cost.cacheWrite) * usage.cacheWrite) /
    TOKENS_PER_MILLION
  );
}
