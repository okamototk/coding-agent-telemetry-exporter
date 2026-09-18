/** Settings read from environment variables, plus the state directory and debug log. */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { localTimestamp } from "./time.ts";
import type { AgentRuntime } from "./types.ts";

/** First non-empty environment variable. CAT-specific names win over standard OTEL ones. */
export function env(names: readonly string[], fallback = ""): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return fallback;
}

function truthy(raw: string): boolean {
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function flag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return truthy(raw);
}

/**
 * A numeric setting. An unset *or empty* value falls back, like {@link flag}: `Number("")`
 * is 0, which would read as a deliberate zero (a 0 ms wait, a 0 USD rate) rather than as
 * "not configured".
 */
export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_ENDPOINT = "http://localhost:4318";

const SIGNAL_PATH = /\/v1\/(traces|metrics|logs)$/;

interface EndpointSource {
  name: string;
  /**
   * True for a variable naming one signal. OTLP defines those as the **full** URL, while a
   * base variable is an origin that `/v1/<signal>` is appended to.
   */
  perSignal: boolean;
}

/** Whether the URL carries a path of its own, rather than being a bare origin. */
function hasPath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname !== "" && pathname !== "/";
  } catch {
    return false;
  }
}

/**
 * Per-signal OTLP/HTTP URL.
 *
 * A per-signal variable (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `CAT_OTEL_METRICS_ENDPOINT`)
 * is the full URL and keeps its own path; only a base variable (`CAT_OTEL_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_ENDPOINT`) gets `/v1/<signal>` appended. Appending to a per-signal
 * URL used to turn a custom path such as `https://host/otlp-traces` into
 * `https://host/otlp-traces/v1/traces`.
 *
 * Both forms stay forgiving where it cannot be a real path: a bare origin still gets
 * `/v1/<signal>`, and a `/v1/<signal>` suffix is normalized to this signal, so pointing a
 * metrics variable at a URL ending in `/v1/traces` still reaches `/v1/metrics`.
 */
function signalUrl(signal: string, sources: readonly EndpointSource[]): string {
  for (const source of sources) {
    const value = (process.env[source.name] ?? "").trim().replace(/\/+$/, "");
    if (!value) {
      continue;
    }
    const base = value.replace(SIGNAL_PATH, "");
    if (source.perSignal && base === value && hasPath(value)) {
      return value;
    }
    return `${base}/v1/${signal}`;
  }
  return `${DEFAULT_ENDPOINT}/v1/${signal}`;
}

const BASE_ENDPOINT: EndpointSource = {
  name: "OTEL_EXPORTER_OTLP_ENDPOINT",
  perSignal: false,
};

export function tracesUrl(): string {
  return signalUrl("traces", [
    { name: "CAT_OTEL_ENDPOINT", perSignal: false },
    { name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", perSignal: true },
    BASE_ENDPOINT,
  ]);
}

export function metricsUrl(): string {
  return signalUrl("metrics", [
    { name: "CAT_OTEL_METRICS_ENDPOINT", perSignal: true },
    { name: "CAT_OTEL_ENDPOINT", perSignal: false },
    { name: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", perSignal: true },
    BASE_ENDPOINT,
  ]);
}

/** Splits `k=v,k2=v2`. Shared by headers and resource attributes. */
export function kvList(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw.split(",")) {
    const separator = item.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = item.slice(0, separator).trim();
    if (key) {
      out[key] = item.slice(separator + 1).trim();
    }
  }
  return out;
}

/** The operator-supplied resource attributes, as a `k=v` map. */
export function extraResourceAttributes(): Record<string, string> {
  return kvList(env(["CAT_OTEL_RESOURCE_ATTRIBUTES", "OTEL_RESOURCE_ATTRIBUTES"]));
}

/**
 * The extra OTLP headers to send.
 *
 * OTLP specifies these values as percent-encoded (the W3C Baggage rules), which is the only
 * way to put a `,` or `=` in one. Without decoding, the spec-conformant
 * `Authorization=Bearer%20abc` sends a literal `%20` and the Collector answers 401 — which
 * this hook then swallows, being fail-open. Header *names* are used verbatim; only values
 * are decoded, and a value that is not valid encoding is passed through unchanged rather
 * than dropped.
 */
export function otlpHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    kvList(env(["CAT_OTEL_HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"])),
  )) {
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Whether {@link extraResourceAttributes} is also copied onto every metric data point.
 * Default on, like the standard `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` it also reads:
 * a backend that ignores resource attributes on metrics can still group by them, at the
 * cost of multiplying the time series by their cardinality.
 */
export function metricsIncludeResourceAttributes(): boolean {
  const raw = env([
    "CAT_OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES",
    "OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES",
  ]);
  return raw === "" ? true : truthy(raw);
}

export function codexHome(): string {
  return process.env["CODEX_HOME"] || join(homedir(), ".codex");
}

export function claudeHome(): string {
  return process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
}

export function kiroHome(): string {
  return process.env["KIRO_HOME"] || join(homedir(), ".kiro");
}

/**
 * Where Kiro CLI keeps its session store, one `<session_id>.json` per session. Override it
 * when the CLI runs on the legacy `.amazonq` layout (`~/.aws/amazonq/sessions/cli`).
 */
export function kiroSessionsDir(): string {
  return env(["CAT_OTEL_KIRO_SESSIONS_DIR"], join(kiroHome(), "sessions", "cli"));
}

const HOMES: Record<AgentRuntime, () => string> = {
  codex: codexHome,
  claude: claudeHome,
  kiro: kiroHome,
};

export function stateDir(runtime: AgentRuntime = "codex"): string {
  const explicit = env(["CAT_OTEL_STATE_DIR"]);
  if (explicit) {
    return explicit;
  }
  return join((HOMES[runtime] ?? codexHome)(), "otel-genai-hook");
}

export function debug(message: string, runtime: AgentRuntime = "codex"): void {
  if (!flag("CAT_OTEL_DEBUG")) {
    return;
  }
  try {
    const directory = stateDir(runtime);
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "hook.log"), `${localTimestamp()} ${message}\n`, "utf8");
  } catch {
    // Keep going even if the log cannot be written.
  }
}
