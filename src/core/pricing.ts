/** Rate table and cost calculation. Rates are USD per 1M tokens. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { debug, flag, numberEnv, stateDir } from "./env.ts";
import type { AgentRuntime, Usage } from "./types.ts";

export interface Rates {
  input?: number;
  cached_input?: number;
  cache_creation?: number;
  cache_creation_5m?: number;
  cache_creation_1h?: number;
  output?: number;
  /**
   * Rates for a request whose input exceeds `above_input_tokens`. OpenAI prices such a
   * request at the higher rates in full, not just the tokens past the threshold, so these
   * replace the base rates for the whole request.
   */
  long_context?: LongContextRates;
  /**
   * Rates for a request served in fast mode (Claude's `usage.speed: "fast"`). They apply
   * across the full context window, so they replace the base rates and any long-context tier.
   */
  fast?: TierRates;
}

/** A rate set that stands in for the base rates; it cannot nest further tiers. */
export type TierRates = Omit<Rates, "long_context" | "fast">;

export interface LongContextRates extends TierRates {
  above_input_tokens: number;
}

/**
 * Whether a request ran in fast mode: the transcript's `usage.speed`, or a model id with the
 * `-fast` suffix that Microsoft Foundry gives its fast deployments (which report no speed).
 */
export function isFast(model: string | null | undefined, speed: string | null | undefined): boolean {
  return speed === "fast" || (typeof model === "string" && model.endsWith("-fast"));
}

export interface Pricing {
  currency: string;
  default: Rates;
  per_million_tokens: Record<string, Rates>;
  /** The date the rates were checked, `YYYY-MM-DD`. Absent in a table that omits it. */
  as_of?: string;
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

/**
 * The rate-table format this code prices correctly. A downloaded table must carry exactly
 * this `schema`: a table that adds a field changing the price (a new tier, say) bumps it, so
 * an older copy of the hook keeps its own table rather than silently ignoring the new field.
 */
export const PRICING_SCHEMA = 1;

const HERE = dirname(fileURLToPath(import.meta.url));

/** The table shipped with the code. This module sits in core/, one level below src/ or dist/. */
const BUNDLED_PATH = join(HERE, "..", "pricing.json");

/** Where a downloaded table is kept (see pricing-update.ts). */
export function pricingCachePath(runtime: AgentRuntime): string {
  return join(stateDir(runtime), "pricing.json");
}

/**
 * Whether a newer downloaded table may stand in for the bundled one. On by default; off with
 * `CAT_OTEL_PRICING_UPDATE=0`, and off whenever `CAT_OTEL_PRICING_FILE` pins a table, which
 * an operator chose deliberately and nothing should replace.
 */
export function pricingUpdatesEnabled(): boolean {
  return !process.env["CAT_OTEL_PRICING_FILE"] && flag("CAT_OTEL_PRICING_UPDATE", true);
}

/** How old a rate table may get before the debug log points it out. */
const STALE_AFTER_DAYS = 180;

/**
 * Notes an aging rate table in the debug log. Rates move, and a table nobody has revisited
 * reports plausible numbers that are quietly wrong — the one failure mode a cost figure
 * cannot signal on its own. A table with no `as_of` says nothing about its age, so it is
 * left alone rather than warned about on every event.
 */
function warnIfStale(path: string, asOf: string | undefined): void {
  if (asOf === undefined) {
    return;
  }
  const checked = Date.parse(asOf);
  if (Number.isNaN(checked)) {
    debug(`pricing as_of is not a date: ${asOf} (${path})`);
    return;
  }
  const days = Math.floor((Date.now() - checked) / 86_400_000);
  if (days > STALE_AFTER_DAYS) {
    debug(`pricing table is ${days} days old (as_of=${asOf}, ${path}); rates may have changed`);
  }
}

/** A table as read from disk, normalized leniently: a hand-written table may omit fields. */
function normalized(data: unknown): Pricing | string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "not an object";
  }
  const table = data as Partial<Pricing>;
  const as_of = typeof table.as_of === "string" ? table.as_of : undefined;
  return {
    currency: table.currency || "USD",
    default: table.default || FALLBACK_PRICING.default,
    per_million_tokens: table.per_million_tokens || {},
    ...(as_of === undefined ? {} : { as_of }),
  };
}

function readTable(path: string): Pricing | string {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return String(error);
  }
  return normalized(data);
}

const RATE_KEYS = new Set([
  "input",
  "cached_input",
  "cache_creation",
  "cache_creation_5m",
  "cache_creation_1h",
  "output",
]);

/** Why `value` is not a valid rate set, or null. `tier` is which rate set it is. */
function rateProblem(value: unknown, tier: "base" | "long_context" | "fast"): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "not an object";
  }
  for (const [key, rate] of Object.entries(value as Record<string, unknown>)) {
    if (RATE_KEYS.has(key) || (tier === "long_context" && key === "above_input_tokens")) {
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        return `${key} is not a non-negative number`;
      }
    } else if (tier === "base" && (key === "long_context" || key === "fast")) {
      const problem = rateProblem(rate, key);
      if (problem) {
        return `${key}: ${problem}`;
      }
      if (key === "long_context" && !((rate as Record<string, unknown>)["above_input_tokens"] as number > 0)) {
        return "long_context: above_input_tokens is missing";
      }
    } else {
      // A field this code does not know might change the price; ignoring it would misprice.
      return `unknown field ${key}`;
    }
  }
  return null;
}

/**
 * Validates a table from outside the install (a download) strictly, returning why it is
 * unusable or null. The bundled table and a `CAT_OTEL_PRICING_FILE` are trusted as written;
 * a download replaces them without anyone looking, so every rate must check out.
 */
export function pricingProblem(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "not an object";
  }
  const table = data as Record<string, unknown>;
  if (table["schema"] !== PRICING_SCHEMA) {
    return `schema ${JSON.stringify(table["schema"])} is not ${PRICING_SCHEMA}`;
  }
  const asOf = table["as_of"];
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) {
    return "as_of is not a YYYY-MM-DD date";
  }
  if (table["currency"] !== undefined && (typeof table["currency"] !== "string" || !table["currency"])) {
    return "currency is not a string";
  }
  const defaults = rateProblem(table["default"], "base");
  if (defaults) {
    return `default: ${defaults}`;
  }
  const models = table["per_million_tokens"];
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return "per_million_tokens is not an object";
  }
  const entries = Object.entries(models as Record<string, unknown>);
  if (entries.length === 0) {
    return "per_million_tokens is empty";
  }
  for (const [model, rates] of entries) {
    const problem = rateProblem(rates, "base");
    if (problem) {
      return `${model}: ${problem}`;
    }
  }
  return null;
}

/** The downloaded table, if there is one and it passes {@link pricingProblem}. */
export function cachedPricing(runtime: AgentRuntime): Pricing | null {
  const path = pricingCachePath(runtime);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const problem = pricingProblem(data);
  if (problem) {
    debug(`pricing download ignored (${path}): ${problem}`, runtime);
    return null;
  }
  const table = normalized(data);
  return typeof table === "string" ? null : table;
}

/** The table shipped with the code, ignoring any override or download. */
export function bundledPricing(): Pricing {
  const table = readTable(BUNDLED_PATH);
  if (typeof table === "string") {
    // Still report tokens even when the rate table cannot be read.
    debug(`pricing load failed, using fallback rates: ${BUNDLED_PATH} (${table})`);
    return { ...FALLBACK_PRICING };
  }
  return table;
}

/**
 * The rate table to price with: `CAT_OTEL_PRICING_FILE` when set; otherwise the bundled table,
 * or a downloaded one (pricing-update.ts) when its `as_of` is newer.
 */
export function loadPricing(runtime: AgentRuntime = "codex"): Pricing {
  const override = process.env["CAT_OTEL_PRICING_FILE"];
  if (override) {
    const table = readTable(override);
    if (typeof table === "string") {
      debug(`pricing load failed, using fallback rates: ${override} (${table})`, runtime);
      return { ...FALLBACK_PRICING };
    }
    warnIfStale(override, table.as_of);
    return table;
  }
  const bundled = bundledPricing();
  const downloaded = pricingUpdatesEnabled() ? cachedPricing(runtime) : null;
  if (downloaded?.as_of && downloaded.as_of > (bundled.as_of ?? "")) {
    warnIfStale(pricingCachePath(runtime), downloaded.as_of);
    return downloaded;
  }
  warnIfStale(BUNDLED_PATH, bundled.as_of);
  return bundled;
}

/**
 * A remainder that carries on the key's version number: ".5" after "gpt-5", "-5" after
 * "claude-opus-5", "-5-20251101" after "claude-opus-4". A one- or two-digit number is a
 * version; an eight-digit date ("-20251001") or a suffix such as "-mini" or "-1m" is not.
 */
const VERSION_CONTINUATION = /^[.-]\d{1,2}(?![\da-z])/i;

/**
 * [rates, matched]. Resolution order: exact match, longest prefix match, `default`.
 *
 * A prefix match must not end inside a version number. Otherwise "gpt-5" would price
 * "gpt-5.5", and "claude-opus-5" would price "claude-opus-5-5", at the older generation's
 * rates while reporting a match; an unpriced point release falls to `default` instead.
 */
export function ratesFor(model: string | null | undefined, pricing: Pricing): [Rates, boolean] {
  const table = pricing.per_million_tokens;
  if (model) {
    const exact = table[model];
    if (exact) {
      return [exact, true];
    }
    // "gpt-5.1-codex-max-xhigh" picks "gpt-5.1-codex-max" over the shorter "gpt-5.1".
    let best: string | null = null;
    for (const key of Object.keys(table)) {
      if (
        model.startsWith(key) &&
        !VERSION_CONTINUATION.test(model.slice(key.length)) &&
        (best === null || key.length > best.length)
      ) {
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

/**
 * The rates that apply to one request: the fast tier for a fast request, otherwise the
 * long-context tier past its threshold, otherwise the base rates. `null` when the request ran
 * in fast mode but the table has no fast rates for the model.
 */
function ratesForRequest(rates: Rates, inputTokens: number, fast: boolean): Rates | null {
  if (fast) {
    return rates.fast ? { ...rates, ...rates.fast } : null;
  }
  const long = rates.long_context;
  if (!long || !(inputTokens > long.above_input_tokens)) {
    return rates;
  }
  const { above_input_tokens: _threshold, ...higher } = long;
  return { ...rates, ...higher };
}

/**
 * Cost of one request. `usage` must be a single request's: the long-context tier is decided
 * by the size of one prompt, so a sum over several requests would cross the threshold
 * without any one of them doing so.
 */
export function cost(
  usage: Usage,
  model: string | null | undefined,
  pricing: Pricing,
  speed?: string | null,
): CostBreakdown {
  const [baseRates, found] = ratesFor(model, pricing);
  const cached = Math.max(0, usage.cached_input_tokens);
  const cacheCreation = Math.max(0, usage.cache_creation_input_tokens);
  const cacheCreation5m = Math.max(0, usage.cache_creation_5m_input_tokens);
  const cacheCreation1h = Math.max(0, usage.cache_creation_1h_input_tokens);
  const totalInput = Math.max(0, usage.input_tokens);
  // A fast request with no fast rates is priced at the standard rates, which understates it,
  // so it reports pricing_matched=false rather than passing for a priced request.
  const tiered = ratesForRequest(baseRates, totalInput, isFast(model, speed));
  const rates = tiered ?? baseRates;
  const matched = found && tiered !== null;
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
