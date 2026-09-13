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

export function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Per-signal OTLP/HTTP URL. A trailing `/v1/<signal>` is stripped and re-appended so
 * that a bare base URL and a signal-qualified one produce the same result.
 */
function signalUrl(signal: string, names: readonly string[]): string {
  const base = env([...names, "OTEL_EXPORTER_OTLP_ENDPOINT"], "http://localhost:4318")
    .replace(/\/+$/, "")
    .replace(/\/v1\/(traces|metrics|logs)$/, "");
  return `${base}/v1/${signal}`;
}

export function tracesUrl(): string {
  return signalUrl("traces", ["CAT_OTEL_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]);
}

export function metricsUrl(): string {
  return signalUrl("metrics", [
    "CAT_OTEL_METRICS_ENDPOINT",
    "CAT_OTEL_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
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

export function stateDir(runtime: AgentRuntime = "codex"): string {
  const explicit = env(["CAT_OTEL_STATE_DIR"]);
  if (explicit) {
    return explicit;
  }
  return join(runtime === "claude" ? claudeHome() : codexHome(), "otel-genai-hook");
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
