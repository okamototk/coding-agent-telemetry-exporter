/** Rate table and cost calculation. Rates are USD per 1M tokens. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { debug, numberEnv } from "./env.ts";
import type { Usage } from "./types.ts";

export interface Rates {
  input?: number;
  cached_input?: number;
  cache_creation?: number;
  cache_creation_5m?: number;
  cache_creation_1h?: number;
  output?: number;
}

export interface Pricing {
  currency: string;
  default: Rates;
  per_million_tokens: Record<string, Rates>;
}

export interface CostBreakdown {
  uncachedInputTokens: number;
  /** The whole input side: uncached input, cache reads, and cache writes. */
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  /** false signals the model was not in the table and `default` rates were used. */
  pricingMatched: boolean;
  /**
   * The input side split by cost class. These three plus {@link outputCost} add up to
   * {@link totalCost}, which is what the per-class breakdown proposed in
   * https://github.com/open-telemetry/semantic-conventions-genai/issues/484 needs (see
   * spans.ts for how they are emitted).
   */
  inputTokenCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  /**
   * Whether the per-class split above accounts for {@link totalCost}. False when the amount
   * came from a metered total rather than from per-token rates (see {@link creditCost}), in
   * which case the breakdown is not emitted.
   */
  classified: boolean;
}

const FALLBACK_PRICING: Pricing = {
  currency: "USD",
  default: { input: 1.25, cached_input: 0.125, output: 10.0 },
  per_million_tokens: {},
};

const HERE = dirname(fileURLToPath(import.meta.url));

function pricingCandidates(): string[] {
  const override = process.env["CAT_OTEL_PRICING_FILE"];
  if (override) {
    return [override];
  }
  // After a build the hook runs from dist/, so look both alongside it and one level up.
  return [join(HERE, "pricing.json"), join(HERE, "..", "pricing.json")];
}

export function loadPricing(): Pricing {
  const failures: string[] = [];
  for (const path of pricingCandidates()) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      failures.push(`${path} (${String(error)})`);
      continue;
    }
    if (!data || typeof data !== "object") {
      failures.push(`${path} (not an object)`);
      continue;
    }
    const table = data as Partial<Pricing>;
    return {
      currency: table.currency || "USD",
      default: table.default || FALLBACK_PRICING.default,
      per_million_tokens: table.per_million_tokens || {},
    };
  }
  // Still report tokens even when the rate table cannot be read.
  debug(`pricing load failed, using fallback rates: ${failures.join(", ")}`);
  return { ...FALLBACK_PRICING };
}

/** [rates, matched]. Resolution order: exact match, longest prefix match, `default`. */
export function ratesFor(model: string | null | undefined, pricing: Pricing): [Rates, boolean] {
  const table = pricing.per_million_tokens;
  if (model) {
    const exact = table[model];
    if (exact) {
      return [exact, true];
    }
    // "gpt-5.1-codex-max-xhigh" picks "gpt-5.1-codex-max" over the shorter "gpt-5.1-codex".
    let best: string | null = null;
    for (const key of Object.keys(table)) {
      if (model.startsWith(key) && (best === null || key.length > best.length)) {
        best = key;
      }
    }
    if (best !== null) {
      return [table[best] as Rates, true];
    }
  }
  return [pricing.default || FALLBACK_PRICING.default, false];
}

/**
 * Cost from a metered credit amount, or null when there is nothing to report.
 *
 * Kiro CLI does not meter tokens: it reports what a turn consumed in **credits**, its own
 * plan unit, so there is no token count to apply a per-token rate to. Money therefore needs
 * one number the rate table cannot hold — what a credit costs — supplied through
 * `CAT_OTEL_KIRO_CREDIT_USD`. Unset (the default), no monetary cost is emitted at all and
 * the credits stand on their own as `kiro.usage.credits`.
 */
export function creditCost(credits: number, pricing: Pricing): CostBreakdown | null {
  const rate = numberEnv("CAT_OTEL_KIRO_CREDIT_USD", 0);
  if (!(rate > 0) || !(credits > 0)) {
    return null;
  }
  const total = credits * rate;
  return {
    uncachedInputTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: total,
    currency: pricing.currency || "USD",
    // The rate was configured explicitly, so no fallback was needed.
    pricingMatched: true,
    inputTokenCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    classified: false,
  };
}

export function cost(usage: Usage, model: string | null | undefined, pricing: Pricing): CostBreakdown {
  const [rates, matched] = ratesFor(model, pricing);
  const cached = Math.max(0, usage.cached_input_tokens);
  const cacheCreation = Math.max(0, usage.cache_creation_input_tokens);
  const cacheCreation5m = Math.max(0, usage.cache_creation_5m_input_tokens);
  const cacheCreation1h = Math.max(0, usage.cache_creation_1h_input_tokens);
  const totalInput = Math.max(0, usage.input_tokens);
  // The canonical input_tokens is a total that includes cache reads and creation.
  const uncached = Math.max(0, totalInput - cached - cacheCreation);
  const output = Math.max(0, usage.output_tokens);

  const inputCost = (uncached * (rates.input || 0)) / 1_000_000;
  const cachedCost = (cached * (rates.cached_input || 0)) / 1_000_000;
  const genericCreation = Math.max(0, cacheCreation - cacheCreation5m - cacheCreation1h);
  const creationCost =
    (genericCreation * (rates.cache_creation || rates.input || 0) +
      cacheCreation5m * (rates.cache_creation_5m || rates.cache_creation || rates.input || 0) +
      cacheCreation1h * (rates.cache_creation_1h || rates.cache_creation || rates.input || 0)) /
    1_000_000;
  const outputCost = (output * (rates.output || 0)) / 1_000_000;
  return {
    uncachedInputTokens: uncached,
    inputCost: inputCost + cachedCost + creationCost,
    outputCost,
    totalCost: inputCost + cachedCost + creationCost + outputCost,
    currency: pricing.currency || "USD",
    pricingMatched: matched,
    inputTokenCost: inputCost,
    cacheReadCost: cachedCost,
    cacheWriteCost: creationCost,
    classified: true,
  };
}
