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
  // "gpt-5.1-codex-max-xhigh" must pick "gpt-5.1-codex-max", not "gpt-5.1-codex" or "gpt-5.1".
  const [rates, matched] = ratesFor("gpt-5.1-codex-max-xhigh", BUNDLED);
  assert.equal(matched, true);
  assert.equal(rates.input, 1.25);

  const [mini] = ratesFor("gpt-5.1-codex-mini-2026", BUNDLED);
  assert.equal(mini.input, 0.25);
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
      /^claude-(fable|mythos|opus|sonnet|haiku|3-5-haiku)-\d/,
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
    ratesFor("claude-haiku-4-5", BUNDLED)[0].input,
    ratesFor("claude-3-5-haiku-20241022", BUNDLED)[0].input,
  );
  assert.notEqual(
    ratesFor("claude-opus-5", BUNDLED)[0].input,
    ratesFor("claude-opus-4-1-20250805", BUNDLED)[0].input,
  );
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
  // Fable 5.1 / Mythos 5.1, which are 0.025x.
  const quarterRead = new Set(["claude-fable-5-1", "claude-mythos-5-1"]);
  for (const [model, rates] of Object.entries(BUNDLED.per_million_tokens)) {
    if (!model.startsWith("claude-")) {
      continue;
    }
    const input = rates.input ?? 0;
    assert.ok(input > 0, model);
    const readMultiplier = quarterRead.has(model) ? 0.025 : 0.1;
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
