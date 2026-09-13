/**
 * Builds and sends OTLP/HTTP (JSON). No SDK: the ExportTraceServiceRequest is assembled
 * and POSTed using Node's standard modules alone. Metrics (ExportMetricsServiceRequest)
 * are built in metrics.ts on top of {@link postOtlp} and {@link resourceAttributes}.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { debug, env, extraResourceAttributes, kvList, tracesUrl } from "./env.ts";

export const SCOPE_NAME = "agent.otel.genai.hook";
export const SCOPE_VERSION = "1.0.0";

/** SPAN_KIND_INTERNAL / SPAN_KIND_CLIENT */
export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_CLIENT = 3;

/**
 * An OTLP attribute value. A JS number does not distinguish int from double, so wrap
 * anything that must be sent as a double in {@link double} (costs always are).
 */
export type AttrValue = string | number | boolean | bigint | { readonly double: number } | null | undefined;

export interface Attr {
  key: string;
  value: Record<string, unknown>;
}

export function double(value: number): { readonly double: number } {
  return { double: value };
}

export function attr(key: string, value: AttrValue): Attr | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }
  if (typeof value === "bigint") {
    return { key, value: { intValue: value.toString() } };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "object") {
    return { key, value: { doubleValue: value.double } };
  }
  return { key, value: { stringValue: String(value) } };
}

export function attrs(pairs: readonly (readonly [string, AttrValue])[]): Attr[] {
  const out: Attr[] = [];
  for (const [key, value] of pairs) {
    const item = attr(key, value);
    if (item !== null) {
      out.push(item);
    }
  }
  return out;
}

/**
 * Converts any JS value to an OTLP AnyValue. Arrays and objects become arrayValue /
 * kvlistValue, which lets event attributes carry the structured values that span
 * attributes cannot express (semconv requires structured values on events).
 */
export function anyValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "bigint") {
    return { intValue: value.toString() };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  if (typeof value === "object") {
    const values: Attr[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== null && item !== undefined) {
        values.push({ key, value: anyValue(item) });
      }
    }
    return { kvlistValue: { values } };
  }
  return { stringValue: String(value) };
}

/** An attribute holding a structured value (array or object), for use on events. */
export function structuredAttr(key: string, value: unknown): Attr | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value) && value.length === 0) {
    return null;
  }
  return { key, value: anyValue(value) };
}

/** An event carried on a span (trace event). semconv events go here. */
export interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: Attr[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  events?: SpanEvent[];
  status?: { code: number; message: string };
}

export interface SpanInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Attr[];
  events?: readonly (SpanEvent | null)[] | null;
  kind?: number;
  error?: string | null;
}

export function span(input: SpanInput): OtlpSpan {
  const endNs = input.endNs < input.startNs ? input.startNs : input.endNs;
  const built: OtlpSpan = {
    traceId: input.traceId,
    spanId: input.spanId,
    name: input.name,
    kind: input.kind ?? SPAN_KIND_INTERNAL,
    startTimeUnixNano: input.startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: input.attributes,
  };
  if (input.parentSpanId) {
    built.parentSpanId = input.parentSpanId;
  }
  const events = (input.events ?? []).filter((event): event is SpanEvent => event !== null);
  if (events.length > 0) {
    built.events = events;
  }
  if (input.error) {
    built.status = { code: 2, message: input.error.slice(0, 500) }; // STATUS_CODE_ERROR
  }
  return built;
}

export function resourceAttributes(serviceName: string): Attr[] {
  const pairs: [string, AttrValue][] = [
    ["service.name", serviceName],
    ["telemetry.sdk.name", SCOPE_NAME],
    ["telemetry.sdk.language", "nodejs"],
  ];
  for (const [key, value] of Object.entries(extraResourceAttributes())) {
    pairs.push([key, value]);
  }
  return attrs(pairs);
}

/**
 * POSTs OTLP/HTTP (JSON). Sending is fail-open: the promise never rejects, even when the
 * Collector is down. `summary` describes the payload for the debug log.
 */
export function postOtlp(url: string, payload: unknown, summary: string): Promise<void> {
  let target: URL;
  try {
    target = new URL(url);
  } catch (error) {
    debug(`export failed url=${url} err=${String(error)}`);
    return Promise.resolve();
  }

  const body = Buffer.from(JSON.stringify(payload), "utf8");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    ...kvList(env(["CAT_OTEL_HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"])),
  };
  const rawTimeout = env(["CAT_OTEL_TIMEOUT"]);
  const timeout = rawTimeout ? Number(rawTimeout) : Number.NaN;
  const timeoutMs = Math.max(1, (Number.isFinite(timeout) ? timeout : 3) * 1000);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<void>((resolve) => {
    const request = transport(target, { method: "POST", headers, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (chunks.length < 8) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 400) {
          const text = Buffer.concat(chunks).toString("utf8").slice(0, 300);
          debug(`export http error url=${url} status=${status} body=${JSON.stringify(text)}`);
        } else {
          debug(`export ok url=${url} ${summary} status=${status}`);
        }
        resolve();
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    request.on("error", (error) => {
      debug(`export failed url=${url} err=${error.message}`);
      resolve();
    });
    request.end(body);
  });
}

/** Builds an ExportTraceServiceRequest and sends it. */
export function exportSpans(spans: readonly OtlpSpan[], serviceName: string): Promise<void> {
  if (spans.length === 0) {
    return Promise.resolve();
  }
  return postOtlp(
    tracesUrl(),
    {
      resourceSpans: [
        {
          resource: { attributes: resourceAttributes(serviceName) },
          scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans }],
        },
      ],
    },
    `spans=${spans.length}`,
  );
}
