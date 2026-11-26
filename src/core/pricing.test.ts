/** Unit tests for rate-table resolution and the cost split. */

import assert from "node:assert/strict";
import test from "node:test";

import { cost, loadPricing, ratesFor, type Pricing } from "./pricing.ts";
import { emptyUsage, type Usage } from "./types.ts";

const BUNDLED = loadPricing();

function usage(parts: Partial<Usage>): Usage {
  return { ...emptyUsage(), ...parts };
}

test("the bundled table loads with a currency and an as_of date", () => {
  assert.equal(BUNDLED.currency, "USD");
  assert.match(BUNDLED.as_of ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.keys(BUNDLED.per_million_tokens).length > 0);
});

test("an exact model name wins", () => {
  const [rates, matched] = ratesFor("claude-haiku-4-5", BUNDLED);
  assert.equal(matched, true);
  assert.equal(rates.input, 1.0);
  assert.equal(rates.output, 5.0);
});

test("a dated snapshot resolves through its version-qualified key", () => {
  for (const [model, input] of [
    ["claude-haiku-4-5-20251001", 1.0],
    ["claude-opus-4-5-20251101", 5.0],
    ["claude-sonnet-4-5-20250929", 3.0],
  ] as const) {
    const [rates, matched] = ratesFor(model, BUNDLED);
    assert.equal(matched, true, model);
    assert.equal(rates.input, input, model);
  }
});

test("the longest prefix wins over a shorter one", () => {
  // "gpt-5.5-pro-xhigh" must pick "gpt-5.5-pro", not "gpt-5.5".
  const [rates, matched] = ratesFor("gpt-5.5-pro-xhigh", BUNDLED);
  assert.equal(matched, true);
  assert.equal(rates.input, 30);

  const [mini] = ratesFor("gpt-5.4-mini-2026-03-17", BUNDLED);
  assert.equal(mini.input, 0.75);
});

test("no family-wide Claude key spans a generation", () => {
  // A bare "claude-opus" / "claude-sonnet" / "claude-haiku" key would prefix-match every
  // generation and keep applying one generation's rates after the next was repriced.
  for (const key of Object.keys(BUNDLED.per_million_tokens)) {
    if (!key.startsWith("claude-")) {
      continue;
    }
    assert.match(
      key,
      /^claude-(fable|mythos|opus|sonnet|haiku)-\d/,
      `${key} is not version-qualified`,
    );
  }
});

test("generations that are priced differently do not share rates", () => {
  // The regression this guards: one key covering both would silently misprice one of them.
  assert.notEqual(
    ratesFor("claude-sonnet-5", BUNDLED)[0].input,
    ratesFor("claude-sonnet-4-6", BUNDLED)[0].input,
  );
  assert.notEqual(
    ratesFor("claude-haiku-5-5", BUNDLED)[0].input,
    ratesFor("claude-haiku-4-5", BUNDLED)[0].input,
  );
  assert.notEqual(
    ratesFor("claude-opus-5", BUNDLED)[0].input,
    ratesFor("claude-opus-4-1-20250805", BUNDLED)[0].input,
  );
});

test("a point release resolves to its own key, not the shorter one it extends", () => {
  for (const [model, own] of [
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["gpt-5.5-xhigh", "gpt-5.5"],
    ["gpt-5.4-mini", "gpt-5.4-mini"],
    ["gpt-5.2-pro", "gpt-5.2-pro"],
  ] as const) {
    const [rates, matched] = ratesFor(model, BUNDLED);
    assert.equal(matched, true, model);
    assert.equal(rates, BUNDLED.per_million_tokens[own], model);
  }
});

test("a prefix match never ends inside a version number", () => {
  // Without this, "gpt-5" would price "gpt-5.5" and "claude-opus-5" would price
  // "claude-opus-5-5" at the older generation's rates, reported as a match.
  const table: Pricing = {
    currency: "USD",
    default: { input: 1 },
    per_million_tokens: {
      "gpt-5": { input: 2 },
      "claude-opus-5": { input: 3 },
      "claude-opus-4": { input: 4 },
    },
  };
  for (const model of ["gpt-5.5", "gpt-5.5-xhigh", "gpt-5.10", "claude-opus-5-5", "claude-opus-4-5-20251101"]) {
    assert.deepEqual(ratesFor(model, table), [{ input: 1 }, false], model);
  }
  for (const [model, input] of [
    ["gpt-5-2025-08-07", 2],
    ["gpt-5-codex", 2],
    ["claude-opus-5-20260101", 3],
    ["claude-opus-5@20260101", 3],
    ["claude-opus-5-1m", 3],
  ] as const) {
    assert.deepEqual(ratesFor(model, table), [{ input }, true], model);
  }
});

test("a request past the long-context threshold is priced at the higher rates in full", () => {
  const table: Pricing = {
    currency: "USD",
    default: {},
    per_million_tokens: {
      m: {
        input: 2,
        cached_input: 0.2,
        output: 10,
        long_context: { above_input_tokens: 272_000, input: 4, cached_input: 0.4, output: 15 },
      },
    },
  };
  const at = cost(usage({ input_tokens: 272_000, cached_input_tokens: 100_000, output_tokens: 1_000_000 }), "m", table);
  assert.equal(at.inputTokenCost, (172_000 * 2) / 1e6);
  assert.equal(at.cacheReadCost, (100_000 * 0.2) / 1e6);
  assert.equal(at.outputCost, 10);

  const past = cost(usage({ input_tokens: 272_001, cached_input_tokens: 100_000, output_tokens: 1_000_000 }), "m", table);
  assert.equal(past.inputTokenCost, (172_001 * 4) / 1e6);
  assert.equal(past.cacheReadCost, (100_000 * 0.4) / 1e6);
  assert.equal(past.outputCost, 15);
  assert.equal(past.pricingMatched, true);
});

test("the bundled OpenAI long-context tiers are 2x input and cache, 1.5x output", () => {
  let tiers = 0;
  for (const [model, rates] of Object.entries(BUNDLED.per_million_tokens)) {
    const long = rates.long_context;
    if (!long || !model.startsWith("gpt-")) {
      continue;
    }
    tiers += 1;
    assert.equal(long.above_input_tokens, 272_000, model);
    assert.ok(Math.abs((long.input ?? 0) - (rates.input ?? 0) * 2) < 1e-9, `${model} input`);
    assert.ok(Math.abs((long.cached_input ?? 0) - (rates.cached_input ?? 0) * 2) < 1e-9, `${model} cache`);
    assert.ok(Math.abs((long.output ?? 0) - (rates.output ?? 0) * 1.5) < 1e-9, `${model} output`);
  }
  assert.ok(tiers > 0);
});

test("Claude Haiku 5.5 past 100K prompt tokens pays 5x on every rate, cache writes included", () => {
  const rates = BUNDLED.per_million_tokens["claude-haiku-5-5"];
  assert.ok(rates?.long_context);
  const long = rates.long_context;
  assert.equal(long.above_input_tokens, 100_000);
  for (const key of ["input", "cached_input", "cache_creation_5m", "cache_creation_1h", "output"] as const) {
    assert.ok(Math.abs((long[key] ?? 0) - (rates[key] ?? 0) * 5) < 1e-9, key);
  }
  // The prompt length counts cache reads and writes: 40K uncached + 50K read + 20K written
  // is 110K, over the threshold although no one share is.
  const past = cost(
    usage({
      input_tokens: 110_000,
      cached_input_tokens: 50_000,
      cache_creation_input_tokens: 20_000,
      cache_creation_5m_input_tokens: 20_000,
      output_tokens: 1_000,
    }),
    "claude-haiku-5-5",
    BUNDLED,
  );
  assert.ok(Math.abs(past.inputTokenCost - (40_000 * 0.5) / 1e6) < 1e-12);
  assert.ok(Math.abs(past.cacheReadCost - (50_000 * 0.05) / 1e6) < 1e-12);
  assert.ok(Math.abs(past.cacheWriteCost - (20_000 * 0.625) / 1e6) < 1e-12);
  assert.ok(Math.abs(past.outputCost - (1_000 * 2.5) / 1e6) < 1e-12);
});

test("an unknown model falls to default and reports pricing_matched=false", () => {
  const [rates, matched] = ratesFor("some-model-nobody-priced", BUNDLED);
  assert.equal(matched, false);
  assert.deepEqual(rates, BUNDLED.default);

  const breakdown = cost(usage({ input_tokens: 1_000_000 }), "some-model-nobody-priced", BUNDLED);
  assert.equal(breakdown.pricingMatched, false);
});

test("a null or empty model falls to default", () => {
  assert.equal(ratesFor(null, BUNDLED)[1], false);
  assert.equal(ratesFor("", BUNDLED)[1], false);
  assert.equal(ratesFor(undefined, BUNDLED)[1], false);
});

test("cost splits the input side into uncached, cache read, and cache write", () => {
  const table: Pricing = {
    currency: "USD",
    default: {},
    per_million_tokens: {
      "test-model": {
        input: 10,
        cached_input: 1,
        cache_creation_5m: 12.5,
        cache_creation_1h: 20,
        output: 50,
      },
    },
  };
  // input_tokens is the whole prompt: 100 uncached + 200 cache read + 300 cache write.
  const breakdown = cost(
    usage({
      input_tokens: 600_000,
      cached_input_tokens: 200_000,
      cache_creation_input_tokens: 300_000,
      cache_creation_5m_input_tokens: 100_000,
      cache_creation_1h_input_tokens: 200_000,
      output_tokens: 40_000,
    }),
    "test-model",
    table,
  );

  assert.equal(breakdown.uncachedInputTokens, 100_000);
  assert.equal(breakdown.inputTokenCost, (100_000 * 10) / 1e6); // 1.0
  assert.equal(breakdown.cacheReadCost, (200_000 * 1) / 1e6); // 0.2
  // The 5m and 1h writes are charged at their own rates, not at the base input rate.
  assert.equal(breakdown.cacheWriteCost, (100_000 * 12.5 + 200_000 * 20) / 1e6); // 5.25
  assert.equal(breakdown.outputCost, (40_000 * 50) / 1e6); // 2.0
  assert.equal(breakdown.classified, true);

  // The per-class figures must add up to the total the cost attribute reports.
  const summed =
    breakdown.inputTokenCost +
    breakdown.cacheReadCost +
    breakdown.cacheWriteCost +
    breakdown.outputCost;
  assert.ok(Math.abs(breakdown.totalCost - summed) < 1e-9);
  assert.ok(Math.abs(breakdown.inputCost + breakdown.outputCost - breakdown.totalCost) < 1e-9);
});

test("a cache write with no per-TTL split falls back to the generic then the input rate", () => {
  const generic: Pricing = {
    currency: "USD",
    default: {},
    per_million_tokens: { m: { input: 10, cache_creation: 12.5, output: 50 } },
  };
  const written = usage({
    input_tokens: 100_000,
    cache_creation_input_tokens: 100_000,
  });
  assert.equal(cost(written, "m", generic).cacheWriteCost, (100_000 * 12.5) / 1e6);

  const bare: Pricing = {
    currency: "USD",
    default: {},
    per_million_tokens: { m: { input: 10, output: 50 } },
  };
  assert.equal(cost(written, "m", bare).cacheWriteCost, (100_000 * 10) / 1e6);
});

test("negative or missing counts never produce a negative cost", () => {
  const breakdown = cost(
    usage({ input_tokens: -5, cached_input_tokens: -5, output_tokens: -5 }),
    "claude-opus-5",
    BUNDLED,
  );
  assert.equal(breakdown.totalCost, 0);
  assert.equal(breakdown.uncachedInputTokens, 0);
});

test("the bundled Claude rates follow the published cache multipliers", () => {
  // Cache writes are 1.25x (5m) and 2x (1h) the base input rate; reads are 0.1x, except on
  // Fable / Mythos 5.1 and 5.2, which are 0.025x, and Opus 5.5 / Sonnet 5.5, which are 0.05x.
  const quarterRead = new Set([
    "claude-fable-5-2",
    "claude-mythos-5-2",
    "claude-fable-5-1",
    "claude-mythos-5-1",
  ]);
  const halfRead = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
  for (const [model, rates] of Object.entries(BUNDLED.per_million_tokens)) {
    if (!model.startsWith("claude-")) {
      continue;
    }
    const input = rates.input ?? 0;
    assert.ok(input > 0, model);
    const readMultiplier = quarterRead.has(model) ? 0.025 : halfRead.has(model) ? 0.05 : 0.1;
    assert.ok(
      Math.abs((rates.cached_input ?? 0) - input * readMultiplier) < 1e-9,
      `${model} cache read`,
    );
    assert.ok(
      Math.abs((rates.cache_creation_5m ?? 0) - input * 1.25) < 1e-9,
      `${model} 5m cache write`,
    );
    assert.ok(
      Math.abs((rates.cache_creation_1h ?? 0) - input * 2) < 1e-9,
      `${model} 1h cache write`,
    );
  }
});

test("a fast-mode request is priced at the fast tier in full, cache rates included", () => {
  const u = usage({
    input_tokens: 300_000,
    cached_input_tokens: 100_000,
    cache_creation_input_tokens: 50_000,
    cache_creation_5m_input_tokens: 30_000,
    cache_creation_1h_input_tokens: 20_000,
    output_tokens: 10_000,
  });
  const standard = cost(u, "claude-opus-5-5", BUNDLED, "standard");
  const fast = cost(u, "claude-opus-5-5", BUNDLED, "fast");
  assert.equal(fast.pricingMatched, true);
  // Opus 5.5 fast: $8 / $40, cache read 0.05x, writes 1.25x / 2x.
  assert.ok(Math.abs(fast.inputTokenCost - (150_000 * 8) / 1e6) < 1e-12);
  assert.ok(Math.abs(fast.cacheReadCost - (100_000 * 0.4) / 1e6) < 1e-12);
  assert.ok(Math.abs(fast.cacheWriteCost - (30_000 * 10 + 20_000 * 16) / 1e6) < 1e-12);
  assert.ok(Math.abs(fast.outputCost - (10_000 * 40) / 1e6) < 1e-12);
  assert.ok(Math.abs(fast.totalCost - standard.totalCost * 2) < 1e-9);
  // No speed, or "standard", is the base rate.
  assert.equal(cost(u, "claude-opus-5-5", BUNDLED).totalCost, standard.totalCost);
});

test("a -fast model id (Microsoft Foundry) is priced at the fast tier", () => {
  const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  const breakdown = cost(u, "claude-opus-5-5-fast", BUNDLED);
  assert.equal(breakdown.pricingMatched, true);
  assert.equal(breakdown.totalCost, 8 + 40);
});

test("a fast request on a model without fast rates reports pricing_matched=false", () => {
  const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  const breakdown = cost(u, "claude-sonnet-5-5", BUNDLED, "fast");
  assert.equal(breakdown.pricingMatched, false);
  // Still priced, at the standard rates, rather than dropped.
  assert.equal(breakdown.totalCost, 2 + 10);
});

test("the fast tier replaces the long-context tier rather than stacking on it", () => {
  const table: Pricing = {
    currency: "USD",
    default: {},
    per_million_tokens: {
      m: {
        input: 1,
        output: 1,
        long_context: { above_input_tokens: 10, input: 5, output: 5 },
        fast: { input: 2, output: 2 },
      },
    },
  };
  const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(cost(u, "m", table, "fast").totalCost, 4);
  assert.equal(cost(u, "m", table).totalCost, 10);
});

test("the bundled Claude fast tiers keep each model's cache multipliers", () => {
  let tiers = 0;
  for (const [model, rates] of Object.entries(BUNDLED.per_million_tokens)) {
    const fast = rates.fast;
    if (!fast) {
      continue;
    }
    tiers += 1;
    const input = fast.input ?? 0;
    const base = rates.input ?? 0;
    assert.ok(input > base, model);
    // Prompt-caching multipliers apply on top of fast pricing.
    for (const key of ["cached_input", "cache_creation_5m", "cache_creation_1h"] as const) {
      const multiplier = (rates[key] ?? 0) / base;
      assert.ok(Math.abs((fast[key] ?? 0) - input * multiplier) < 1e-9, `${model} ${key}`);
    }
  }
  assert.equal(tiers, 5);
});
