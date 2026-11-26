/** Tests for fetching a newer rate table: pricing-update.ts against a local HTTP stub. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bundledPricing, loadPricing, pricingCachePath, pricingProblem } from "./pricing.ts";
import { refreshPricing } from "./pricing-update.ts";

const BUNDLED_FILE = JSON.parse(
  readFileSync(new URL("../pricing.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** The bundled table with `as_of` moved and one rate changed, so a switch is visible. */
function remoteTable(asOf: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const models = structuredClone(BUNDLED_FILE["per_million_tokens"]) as Record<string, Record<string, unknown>>;
  models["claude-opus-5-5"] = { ...models["claude-opus-5-5"], input: 3.5 };
  return { ...BUNDLED_FILE, as_of: asOf, per_million_tokens: models, ...extra };
}

interface Stub {
  url: string;
  requests: IncomingHttpHeaders[];
  close: () => Promise<void>;
}

/** Serves `body` (with an ETag) and answers 304 to a matching If-None-Match. */
async function stub(body: () => string, status = 200): Promise<Stub> {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    const etag = `"v-${body().length}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag });
      response.end();
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json", ETag: etag });
    response.end(body());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/pricing.json`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Runs `body` with a fresh state dir and only the given CAT_OTEL_* settings. */
async function withEnv(settings: Record<string, string>, body: (dir: string) => Promise<void>): Promise<void> {
  const previous = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "pricing-update-"));
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("CAT_OTEL_")) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, { CAT_OTEL_STATE_DIR: dir, ...settings });
    await body(dir);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the bundled table passes the checks a download must pass", () => {
  // What is pushed to main is what every installed hook downloads.
  assert.equal(pricingProblem(BUNDLED_FILE), null);
});

test("a newer table is downloaded and used from then on", async () => {
  const server = await stub(() => JSON.stringify(remoteTable("2099-01-01")));
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: server.url }, async () => {
      assert.equal(loadPricing("claude").per_million_tokens["claude-opus-5-5"]?.input, 4);
      assert.equal(await refreshPricing("claude"), "updated");
      const pricing = loadPricing("claude");
      assert.equal(pricing.as_of, "2099-01-01");
      assert.equal(pricing.per_million_tokens["claude-opus-5-5"]?.input, 3.5);
      // A generic client, nothing about the user.
      assert.equal(server.requests[0]?.["user-agent"], "agent-otel-genai-hook/1.0.0");
    });
  } finally {
    await server.close();
  }
});

test("a table no newer than the bundled one is not used", async () => {
  const server = await stub(() => JSON.stringify(remoteTable(bundledPricing().as_of ?? "2000-01-01")));
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: server.url }, async () => {
      assert.equal(await refreshPricing("codex"), "unchanged");
      assert.equal(existsSync(pricingCachePath("codex")), false);
    });
  } finally {
    await server.close();
  }
});

test("checks at most once per interval, then sends If-None-Match", async () => {
  const server = await stub(() => JSON.stringify(remoteTable("2099-01-01")));
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: server.url }, async () => {
      const start = Date.UTC(2026, 10, 26);
      assert.equal(await refreshPricing("codex", start), "updated");
      assert.equal(await refreshPricing("codex", start + 23 * 3_600_000), "fresh");
      assert.equal(server.requests.length, 1);
      assert.equal(await refreshPricing("codex", start + 25 * 3_600_000), "unchanged");
      assert.equal(server.requests.length, 2);
      assert.match(String(server.requests[1]?.["if-none-match"]), /^"v-/);
    });
  } finally {
    await server.close();
  }
});

for (const [label, table] of [
  ["a newer schema", remoteTable("2099-01-01", { schema: 2 })],
  ["no schema", (() => {
    const { schema: _schema, ...rest } = remoteTable("2099-01-01");
    return rest;
  })()],
  ["a negative rate", (() => {
    const t = remoteTable("2099-01-01");
    (t["per_million_tokens"] as Record<string, Record<string, unknown>>)["gpt-6.2-sol"]!["input"] = -1;
    return t;
  })()],
  ["a rate that is a string", (() => {
    const t = remoteTable("2099-01-01");
    (t["per_million_tokens"] as Record<string, Record<string, unknown>>)["gpt-6.2-sol"]!["output"] = "10";
    return t;
  })()],
  ["an unknown rate field", (() => {
    const t = remoteTable("2099-01-01");
    (t["per_million_tokens"] as Record<string, Record<string, unknown>>)["gpt-6.2-sol"]!["priority"] = { input: 9 };
    return t;
  })()],
  ["no models", remoteTable("2099-01-01", { per_million_tokens: {} })],
  ["a bad as_of", remoteTable("someday")],
] as const) {
  test(`a downloaded table with ${label} is rejected and the bundled one kept`, async () => {
    const server = await stub(() => JSON.stringify(table));
    try {
      await withEnv({ CAT_OTEL_PRICING_URL: server.url }, async () => {
        assert.equal(await refreshPricing("codex"), "rejected");
        assert.equal(existsSync(pricingCachePath("codex")), false);
        assert.equal(loadPricing("codex").as_of, bundledPricing().as_of);
      });
    } finally {
      await server.close();
    }
  });
}

test("a rejected table's ETag is not kept, so an upgraded hook still fetches it", async () => {
  const server = await stub(() => JSON.stringify(remoteTable("2099-01-01", { schema: 2 })));
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: server.url, CAT_OTEL_PRICING_UPDATE_HOURS: "0" }, async () => {
      assert.equal(await refreshPricing("codex"), "rejected");
      assert.equal(await refreshPricing("codex"), "rejected");
      assert.equal(server.requests[1]?.["if-none-match"], undefined);
    });
  } finally {
    await server.close();
  }
});

test("non-JSON, an HTTP error, or no server leave the bundled table in place", async () => {
  const garbage = await stub(() => "<html>rate limited</html>");
  const failing = await stub(() => "{}", 500);
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: garbage.url }, async () => {
      assert.equal(await refreshPricing("codex"), "rejected");
    });
    await withEnv({ CAT_OTEL_PRICING_URL: failing.url }, async () => {
      assert.equal(await refreshPricing("codex"), "failed");
    });
    // A closed port: refused at once.
    const closed = failing.url;
    await failing.close();
    await withEnv({ CAT_OTEL_PRICING_URL: closed }, async () => {
      assert.equal(await refreshPricing("codex"), "failed");
      assert.equal(loadPricing("codex").as_of, bundledPricing().as_of);
    });
  } finally {
    await garbage.close();
  }
});

test("a corrupted download on disk is ignored", async () => {
  await withEnv({ CAT_OTEL_PRICING_UPDATE: "1" }, async () => {
    const path = pricingCachePath("codex");
    writeFileSync(path, JSON.stringify(remoteTable("2099-01-01", { schema: 99 })), "utf8");
    assert.equal(loadPricing("codex").as_of, bundledPricing().as_of);
    writeFileSync(path, "{ truncated", "utf8");
    assert.equal(loadPricing("codex").as_of, bundledPricing().as_of);
  });
});

test("CAT_OTEL_PRICING_UPDATE=0 neither fetches nor uses an earlier download", async () => {
  const server = await stub(() => JSON.stringify(remoteTable("2099-01-01")));
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: server.url }, async () => {
      assert.equal(await refreshPricing("codex"), "updated");
      process.env["CAT_OTEL_PRICING_UPDATE"] = "0";
      assert.equal(await refreshPricing("codex"), "disabled");
      assert.equal(loadPricing("codex").as_of, bundledPricing().as_of);
      assert.equal(server.requests.length, 1);
    });
  } finally {
    await server.close();
  }
});

test("CAT_OTEL_PRICING_FILE pins the table: no fetch, no download used", async () => {
  const server = await stub(() => JSON.stringify(remoteTable("2099-01-01")));
  try {
    await withEnv({ CAT_OTEL_PRICING_URL: server.url }, async (dir) => {
      assert.equal(await refreshPricing("codex"), "updated");
      const pinned = join(dir, "mine.json");
      writeFileSync(pinned, JSON.stringify({ as_of: "2001-01-01", per_million_tokens: { m: { input: 1 } } }));
      process.env["CAT_OTEL_PRICING_FILE"] = pinned;
      assert.equal(await refreshPricing("codex"), "disabled");
      assert.equal(loadPricing("codex").as_of, "2001-01-01");
      assert.equal(server.requests.length, 1);
    });
  } finally {
    await server.close();
  }
});
