/** Unit tests for the settings helpers: endpoint resolution, headers, and numeric flags. */

import assert from "node:assert/strict";
import test from "node:test";

import { kvList, metricsUrl, numberEnv, otlpHeaders, tracesUrl } from "./env.ts";

/** The variables these tests set. Cleared before each case so none leaks into the next. */
const MANAGED = [
  "CAT_OTEL_ENDPOINT",
  "CAT_OTEL_METRICS_ENDPOINT",
  "CAT_OTEL_HEADERS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "CAT_OTEL_TEST_NUMBER",
] as const;

/**
 * Runs `body` with exactly `vars` set, restoring the previous environment afterwards.
 * The helpers read `process.env` directly, so the real environment has to be staged.
 */
function withEnv(vars: Record<string, string>, body: () => void): void {
  const saved = new Map(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) {
    delete process.env[name];
  }
  Object.assign(process.env, vars);
  try {
    body();
  } finally {
    for (const name of MANAGED) {
      delete process.env[name];
    }
    for (const [name, value] of saved) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }
}

test("the default endpoint is the local Collector, per signal", () => {
  withEnv({}, () => {
    assert.equal(tracesUrl(), "http://localhost:4318/v1/traces");
    assert.equal(metricsUrl(), "http://localhost:4318/v1/metrics");
  });
});

test("a base endpoint gets /v1/<signal> appended, with or without the suffix", () => {
  for (const value of [
    "http://collector:4318",
    "http://collector:4318/",
    "http://collector:4318/v1/traces",
    "http://collector:4318/v1/metrics",
  ]) {
    withEnv({ CAT_OTEL_ENDPOINT: value }, () => {
      assert.equal(tracesUrl(), "http://collector:4318/v1/traces", value);
      assert.equal(metricsUrl(), "http://collector:4318/v1/metrics", value);
    });
  }
});

test("OTEL_EXPORTER_OTLP_ENDPOINT is a base too", () => {
  withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com" }, () => {
    assert.equal(tracesUrl(), "https://otlp.example.com/v1/traces");
    assert.equal(metricsUrl(), "https://otlp.example.com/v1/metrics");
  });
});

test("a per-signal endpoint keeps a custom path instead of having /v1/<signal> appended", () => {
  withEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://ingest.example.com/otlp-traces" }, () => {
    assert.equal(tracesUrl(), "https://ingest.example.com/otlp-traces");
  });
  withEnv({ CAT_OTEL_METRICS_ENDPOINT: "https://ingest.example.com/write?db=otel" }, () => {
    assert.equal(metricsUrl(), "https://ingest.example.com/write?db=otel");
  });
});

test("a per-signal endpoint that is a bare origin still gets /v1/<signal>", () => {
  withEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318" }, () => {
    assert.equal(tracesUrl(), "http://collector:4318/v1/traces");
  });
  withEnv({ CAT_OTEL_METRICS_ENDPOINT: "http://collector:4318/" }, () => {
    assert.equal(metricsUrl(), "http://collector:4318/v1/metrics");
  });
});

test("a per-signal endpoint carrying the wrong /v1/<signal> is normalized to its own", () => {
  withEnv({ CAT_OTEL_METRICS_ENDPOINT: "http://collector:4318/v1/traces" }, () => {
    assert.equal(metricsUrl(), "http://collector:4318/v1/metrics");
  });
});

test("CAT_OTEL_ENDPOINT wins over the standard variables, and metrics can diverge", () => {
  withEnv(
    {
      CAT_OTEL_ENDPOINT: "http://primary:4318",
      CAT_OTEL_METRICS_ENDPOINT: "http://secondary:4318",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored:4318",
    },
    () => {
      assert.equal(tracesUrl(), "http://primary:4318/v1/traces");
      assert.equal(metricsUrl(), "http://secondary:4318/v1/metrics");
    },
  );
});

test("an empty endpoint falls through to the next source", () => {
  withEnv({ CAT_OTEL_ENDPOINT: "", OTEL_EXPORTER_OTLP_ENDPOINT: "http://fallback:4318" }, () => {
    assert.equal(tracesUrl(), "http://fallback:4318/v1/traces");
  });
});

test("kvList splits k=v pairs and keeps = inside the value", () => {
  assert.deepEqual(kvList("a=1,b=2"), { a: "1", b: "2" });
  assert.deepEqual(kvList("token=abc=def"), { token: "abc=def" });
  assert.deepEqual(kvList(" a = 1 "), { a: "1" });
  assert.deepEqual(kvList("novalue"), {});
  assert.deepEqual(kvList(""), {});
});

test("header values are percent-decoded, names are not", () => {
  withEnv({ CAT_OTEL_HEADERS: "Authorization=Bearer%20secret" }, () => {
    assert.deepEqual(otlpHeaders(), { Authorization: "Bearer secret" });
  });
  withEnv({ OTEL_EXPORTER_OTLP_HEADERS: "x-key=a%2Cb" }, () => {
    // %2C is the only way to put a comma in a value, since `,` separates pairs.
    assert.deepEqual(otlpHeaders(), { "x-key": "a,b" });
  });
});

test("a header value that is not valid encoding is passed through unchanged", () => {
  withEnv({ CAT_OTEL_HEADERS: "x-key=100%" }, () => {
    assert.deepEqual(otlpHeaders(), { "x-key": "100%" });
  });
});

test("CAT_OTEL_HEADERS wins over OTEL_EXPORTER_OTLP_HEADERS", () => {
  withEnv({ CAT_OTEL_HEADERS: "a=1", OTEL_EXPORTER_OTLP_HEADERS: "b=2" }, () => {
    assert.deepEqual(otlpHeaders(), { a: "1" });
  });
});

test("numberEnv falls back when unset, empty, or unparseable", () => {
  withEnv({}, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 2000), 2000);
  });
  // Number("") is 0, which would read as a deliberate zero rather than "not configured".
  withEnv({ CAT_OTEL_TEST_NUMBER: "" }, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 2000), 2000);
  });
  withEnv({ CAT_OTEL_TEST_NUMBER: "   " }, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 2000), 2000);
  });
  withEnv({ CAT_OTEL_TEST_NUMBER: "abc" }, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 2000), 2000);
  });
});

test("numberEnv honours a configured value, including an explicit zero", () => {
  withEnv({ CAT_OTEL_TEST_NUMBER: "500" }, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 2000), 500);
  });
  withEnv({ CAT_OTEL_TEST_NUMBER: "0" }, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 2000), 0);
  });
  withEnv({ CAT_OTEL_TEST_NUMBER: "0.005" }, () => {
    assert.equal(numberEnv("CAT_OTEL_TEST_NUMBER", 0), 0.005);
  });
});
