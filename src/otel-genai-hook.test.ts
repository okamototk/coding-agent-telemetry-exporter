/**
 * Self-tests for otel-genai-hook. No dependencies: `node --test dist/` (`npm test`).
 *
 * Against a synthetic rollout JSONL and a local OTLP/HTTP stub, the real hook is run as a
 * subprocess with JSON on stdin, through SessionStart → UserPromptSubmit → Stop →
 * SessionEnd, and the spans received are asserted on.
 *
 * Some fixture content is intentionally Japanese: it keeps the multi-byte paths (byte-wise
 * newline scanning, content truncation) covered.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// src/*.test.ts exercises src/*.ts; dist/*.test.js exercises dist/*.js.
const HOOK = fileURLToPath(import.meta.url).replace(/\.test\.(m?[jt]s)$/, ".$1");

const SESSION_ID = "01a02467-38a1-7ad2-9bc5-32037b0e52aa";
const TURN_ID = "01a02467-3f01-7c50-8fbe-cfc45eb2d56d";
const SECOND_TURN_ID = "01a02467-4a02-7c50-8fbe-cfc45eb2d56e";
const MODEL = "gpt-5.1-codex";

interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpAttribute[];
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events?: OtlpEvent[];
  status?: { code: number; message: string };
}

interface OtlpEnvelope {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: { spans: OtlpSpan[] }[];
  }[];
}

interface OtlpHistogramPoint {
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  min: number;
  max: number;
  bucketCounts: string[];
  explicitBounds: number[];
  attributes: OtlpAttribute[];
}

interface OtlpMetric {
  name: string;
  unit: string;
  description: string;
  histogram: { aggregationTemporality: number; dataPoints: OtlpHistogramPoint[] };
}

interface OtlpMetricEnvelope {
  resourceMetrics: {
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: { metrics: OtlpMetric[] }[];
  }[];
}

/** One request received by the OTLP stub. Metrics and traces are told apart by path. */
interface Delivery {
  path: string;
  body: Record<string, unknown>;
}

type Attributes = Record<string, string | number | boolean>;

function flatten(attributes: OtlpAttribute[]): Attributes {
  const out: Attributes = {};
  for (const attribute of attributes) {
    out[attribute.key] = Object.values(attribute.value)[0] as string | number | boolean;
  }
  return out;
}

/** Converts an OTLP AnyValue back to a plain JS value, to assert on structured event attributes. */
function fromAnyValue(value: Record<string, unknown>): unknown {
  if ("stringValue" in value) {
    return value["stringValue"];
  }
  if ("boolValue" in value) {
    return value["boolValue"];
  }
  if ("intValue" in value) {
    return Number(value["intValue"]);
  }
  if ("doubleValue" in value) {
    return value["doubleValue"];
  }
  if ("arrayValue" in value) {
    const inner = value["arrayValue"] as { values?: Record<string, unknown>[] };
    return (inner.values ?? []).map(fromAnyValue);
  }
  if ("kvlistValue" in value) {
    const inner = value["kvlistValue"] as { values?: OtlpAttribute[] };
    return Object.fromEntries(
      (inner.values ?? []).map((item) => [item.key, fromAnyValue(item.value)]),
    );
  }
  return null;
}

interface Message {
  role: string;
  parts: Record<string, unknown>[];
}

function eventAttributes(span: OtlpSpan, name: string): Record<string, unknown> | null {
  const event = span.events?.find((item) => item.name === name);
  if (!event) {
    return null;
  }
  return Object.fromEntries(
    event.attributes.map((item) => [item.key, fromAnyValue(item.value)]),
  );
}

function usage(input: number, cached: number, output: number, reasoning: number): Record<string, number> {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function rolloutLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function tokenCount(timestamp: string, last: unknown, total: unknown): string {
  return rolloutLine({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: 258400,
      },
      rate_limits: { primary: null, secondary: null },
    },
  });
}

function writeRollout(path: string, options: { secondRequest: boolean }): void {
  const parts = [
    rolloutLine({
      timestamp: "2026-08-25T01:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: SESSION_ID,
        timestamp: "2026-08-25T01:00:00.000Z",
        cwd: "/repo",
        originator: "codex-tui",
        cli_version: "0.149.0",
        source: "cli",
        model_provider: "openai",
        base_instructions: "You are Codex.",
      },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: TURN_ID },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:01.100Z",
      type: "turn_context",
      payload: { turn_id: TURN_ID, model: MODEL, effort: "medium" },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:01.200Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "トークンとコストを OTel に出して" }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
      },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:01.900Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "確認します" }],
        phase: "commentary",
        internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
      },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "printf test" }),
        call_id: "call_test_tool",
        internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
      },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:02.250Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_test_tool",
        output: "Process exited with code 0\nOutput:\ntest\n",
        internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
      },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "exit 7" }),
        call_id: "call_failed_tool",
        internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
      },
    }),
    rolloutLine({
      timestamp: "2026-08-25T01:00:03.100Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_failed_tool",
        output: "Process exited with code 7\nFinal output:\n",
        internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
      },
    }),
    tokenCount("2026-08-25T01:00:05.000Z", usage(10_000, 8_000, 500, 300), usage(10_000, 8_000, 500, 300)),
    // Codex sometimes writes the same token_count twice. The cumulative total has not
    // moved, so this must not be counted as another request.
    tokenCount("2026-08-25T01:00:05.400Z", usage(10_000, 8_000, 500, 300), usage(10_000, 8_000, 500, 300)),
  ];
  if (options.secondRequest) {
    parts.push(
      rolloutLine({
        timestamp: "2026-08-25T01:00:06.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: SECOND_TURN_ID },
      }),
      rolloutLine({
        timestamp: "2026-08-25T01:00:06.100Z",
        type: "turn_context",
        payload: { turn_id: SECOND_TURN_ID, model: MODEL, effort: "medium" },
      }),
      rolloutLine({
        timestamp: "2026-08-25T01:00:06.200Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "続けて" }],
          internal_chat_message_metadata_passthrough: { turn_id: SECOND_TURN_ID },
        },
      }),
      rolloutLine({
        timestamp: "2026-08-25T01:00:08.900Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "完了しました" }],
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: { turn_id: SECOND_TURN_ID },
        },
      }),
      tokenCount("2026-08-25T01:00:09.000Z", usage(12_000, 9_000, 200, 100), usage(22_000, 17_000, 700, 400)),
    );
  }
  // Leave an incomplete trailing line, mimicking a rollout still being appended to.
  parts.push('{"timestamp":"2026-08-25T01:00:10.000Z","type":"event_ms');
  writeFileSync(path, parts.join(""), "utf8");
}

/**
 * Runs the hook once and returns its stdout. spawnSync is unusable here: it blocks the
 * parent's event loop, leaving the OTLP stub unable to answer the hook's POST.
 */
function runHook(payload: unknown, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: environment, stdio: "pipe" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(stdout).toString("utf8");
      try {
        assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
      } catch (error) {
        reject(error as Error);
        return;
      }
      resolve(text);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

interface Collected {
  spans: Map<string, OtlpSpan[]>;
  received: OtlpEnvelope[];
  metrics: OtlpMetric[];
  deliveries: Delivery[];
}

/** Runs the hook for one whole session and returns the stub's spans grouped by kind. */
async function collect(extra: NodeJS.ProcessEnv = {}): Promise<Collected> {
  const deliveries: Delivery[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const workdir = mkdtempSync(join(tmpdir(), "codex-otel-hook-"));
  try {
    const rollout = join(workdir, `rollout-2026-08-25T01-00-00-${SESSION_ID}.jsonl`);
    // A CAT_OTEL_* left in the developer's own shell would otherwise change what the hook
    // emits, so the fixture starts from an environment with none of them set.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("CAT_OTEL_")),
    );
    const environment: NodeJS.ProcessEnv = {
      ...inherited,
      CAT_OTEL_ENDPOINT: endpoint,
      CAT_OTEL_STATE_DIR: join(workdir, "state"),
      CAT_OTEL_CAPTURE_PROMPTS: "1",
      CAT_OTEL_SERVICE_NAME: "codex-test",
      CAT_OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test",
      ...extra,
    };
    const base = { cwd: "/repo", session_id: SESSION_ID, transcript_path: rollout };

    writeRollout(rollout, { secondRequest: false });
    await runHook(
      {
        ...base,
        hook_event_name: "SessionStart",
        model: MODEL,
        permission_mode: "default",
        source: "startup",
      },
      environment,
    );
    await runHook(
      {
        ...base,
        hook_event_name: "UserPromptSubmit",
        model: MODEL,
        permission_mode: "default",
        prompt: "トークンとコストを OTel に出して",
        turn_id: TURN_ID,
      },
      environment,
    );
    const stdout = await runHook(
      {
        ...base,
        hook_event_name: "Stop",
        model: MODEL,
        permission_mode: "default",
        last_assistant_message: "出しました",
        stop_hook_active: false,
        turn_id: TURN_ID,
      },
      environment,
    );
    assert.deepEqual(JSON.parse(stdout), { continue: true }, stdout);

    // Append a second request, then SessionEnd. If the offset works, the first request is
    // not counted twice.
    writeRollout(rollout, { secondRequest: true });
    await runHook({ ...base, hook_event_name: "SessionEnd", reason: "other" }, environment);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const received: OtlpEnvelope[] = [];
  const metrics: OtlpMetric[] = [];
  for (const delivery of deliveries) {
    if ("resourceSpans" in delivery.body) {
      received.push(delivery.body as unknown as OtlpEnvelope);
    }
    if ("resourceMetrics" in delivery.body) {
      for (const resourceMetric of (delivery.body as unknown as OtlpMetricEnvelope)
        .resourceMetrics) {
        for (const scopeMetric of resourceMetric.scopeMetrics) {
          metrics.push(...scopeMetric.metrics);
        }
      }
    }
  }

  const spans = new Map<string, OtlpSpan[]>();
  for (const envelope of received) {
    for (const resourceSpan of envelope.resourceSpans) {
      for (const scopeSpan of resourceSpan.scopeSpans) {
        for (const item of scopeSpan.spans) {
          // gen_ai.operation.name alone identifies the kind of span; there is no custom one.
          const kind = String(flatten(item.attributes)["gen_ai.operation.name"]);
          const bucket = spans.get(kind) ?? [];
          bucket.push(item);
          spans.set(kind, bucket);
        }
      }
    }
  }
  return { spans, received, metrics, deliveries };
}

const { spans, received, metrics, deliveries } = await collect();
const eventMode = await collect({ CAT_OTEL_MESSAGES_MODE: "event" });
const bothMode = await collect({ CAT_OTEL_MESSAGES_MODE: "both" });

function group(kind: string): OtlpSpan[] {
  return spans.get(kind) ?? [];
}

function sortByStart(items: readonly OtlpSpan[]): OtlpSpan[] {
  return [...items].sort(
    (left, right) => Number(BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano)),
  );
}

function byStart(kind: string): OtlpSpan[] {
  return sortByStart(group(kind));
}

/** Pulls the spans of one kind from that mode's run, ordered by start time. */
function fromMode(mode: Collected, kind: string): OtlpSpan[] {
  return sortByStart(mode.spans.get(kind) ?? []);
}

test("one turn is one trace, with no duplicate span IDs", () => {
  assert.equal(group("chat").length, 2, [...spans.keys()].join(","));
  assert.equal(group("execute_tool").length, 2);
  // SessionEnd must not re-emit the turn span Stop already sent under the same span ID.
  assert.equal(group("invoke_agent").length, 2);

  const all = [...spans.values()].flat();
  assert.equal(new Set(all.map((item) => item.traceId)).size, 2);
  assert.equal(new Set(all.map((item) => item.spanId)).size, all.length);
});

test("each trace nests turn → chat / execute_tool", () => {
  const turns = new Map(group("invoke_agent").map((turn) => [turn.spanId, turn]));
  for (const turn of group("invoke_agent")) {
    assert.equal(turn.parentSpanId, undefined);
  }
  for (const child of [...group("chat"), ...group("execute_tool")]) {
    assert.ok(child.parentSpanId !== undefined);
    const turn = turns.get(child.parentSpanId);
    assert.ok(turn);
    assert.equal(child.traceId, turn.traceId);
  }
});

test("sends tool calls as execute_tool spans", () => {
  const tool = group("execute_tool").find(
    (item) => flatten(item.attributes)["gen_ai.tool.call.id"] === "call_test_tool",
  );
  assert.ok(tool);
  const attributes = flatten(tool.attributes);
  assert.equal(tool.name, "execute_tool exec_command");
  assert.equal(attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(attributes["gen_ai.tool.name"], "exec_command");
  assert.equal(attributes["gen_ai.tool.type"], "function");
  assert.equal(attributes["gen_ai.tool.call.id"], "call_test_tool");
  assert.equal(JSON.parse(String(attributes["gen_ai.tool.call.arguments"])).cmd, "printf test");
  assert.match(String(attributes["gen_ai.tool.call.result"]), /test/);
  assert.equal(tool.status, undefined);
});

test("a failed tool call carries an error status", () => {
  const tool = group("execute_tool").find(
    (item) => flatten(item.attributes)["gen_ai.tool.call.id"] === "call_failed_tool",
  );
  assert.ok(tool);
  assert.equal(tool.status?.code, 2);
  assert.equal(tool.status?.message, "tool exited with code 7");
  // semconv makes error.type Conditionally Required on error. The span attribute uses the
  // same well-known fallback value as the metrics.
  assert.equal(flatten(tool.attributes)["error.type"], "_OTHER");

  const succeeded = group("execute_tool").find(
    (item) => flatten(item.attributes)["gen_ai.tool.call.id"] === "call_test_tool",
  );
  assert.ok(succeeded);
  assert.equal("error.type" in flatten(succeeded.attributes), false);
});

test("tokens and cost for the first request", () => {
  const first = byStart("chat")[0];
  assert.ok(first);
  const attributes = flatten(first.attributes);
  assert.equal(first.name, `chat ${MODEL}`);
  assert.equal(attributes["gen_ai.operation.name"], "chat");
  assert.equal(attributes["gen_ai.provider.name"], "openai");
  assert.equal(attributes["gen_ai.request.model"], MODEL);
  assert.equal(attributes["gen_ai.conversation.id"], SESSION_ID);
  assert.equal(attributes["session.id"], SESSION_ID);
  assert.equal(Number(attributes["gen_ai.usage.input_tokens"]), 10_000);
  assert.equal(Number(attributes["gen_ai.usage.output_tokens"]), 500);
  assert.equal(Number(attributes["gen_ai.usage.cache_read.input_tokens"]), 8_000);
  assert.equal(Number(attributes["codex.usage.uncached_input_tokens"]), 2_000);
  assert.equal(Number(attributes["gen_ai.usage.reasoning.output_tokens"]), 300);
  assert.equal(attributes["gen_ai.request.reasoning.level"], "medium");

  // gpt-5.1-codex: 2000*1.25 + 8000*0.125 + 500*10.00 (per 1M)
  const expectedInput = (2_000 * 1.25 + 8_000 * 0.125) / 1_000_000;
  const expectedOutput = (500 * 10.0) / 1_000_000;
  assert.ok(Math.abs(Number(attributes["codex.usage.input_cost"]) - expectedInput) < 1e-9);
  assert.ok(Math.abs(Number(attributes["codex.usage.output_cost"]) - expectedOutput) < 1e-9);
  assert.ok(
    Math.abs(Number(attributes["codex.usage.cost"]) - (expectedInput + expectedOutput)) < 1e-9,
  );
  assert.equal(attributes["codex.usage.cost.currency"], "USD");
  assert.equal(attributes["codex.usage.cost.pricing_matched"], true);
  // gen_ai.* is OTel's namespace; a custom attribute goes there only when semconv (here, an
  // accepted draft) defines it, which is why the bare gen_ai.usage.cost is still absent.
  assert.equal("gen_ai.usage.cost" in attributes, false);
  assert.equal("gen_ai.usage.total_tokens" in attributes, false);
  assert.equal("gen_ai.system" in attributes, false);
});

test("the cost attributes of semconv-genai PR #443 ride on the chat span", () => {
  const first = byStart("chat")[0];
  assert.ok(first);
  const attributes = flatten(first.attributes);
  const expected = (2_000 * 1.25 + 8_000 * 0.125 + 500 * 10.0) / 1_000_000;
  assert.ok(Math.abs(Number(attributes["gen_ai.usage.cost.amount"]) - expected) < 1e-9);
  // Conditionally Required whenever the amount is set.
  assert.equal(attributes["gen_ai.usage.cost.currency"], "USD");
  // The hook computes cost from pricing.json, so it is never the provider's own figure.
  assert.equal(attributes["gen_ai.usage.cost.source"], "local");
  // The extensions stay alongside the draft names, so nothing is lost if the draft changes.
  assert.ok(Math.abs(Number(attributes["codex.usage.cost"]) - expected) < 1e-9);
  // The per-class breakdown is opt-in.
  assert.equal("gen_ai.usage.cost.input" in attributes, false);
  assert.equal("gen_ai.usage.cost.cache_read" in attributes, false);
});

test("the turn span reports no gen_ai cost: the draft excludes children's cost", () => {
  for (const turn of group("invoke_agent")) {
    const attributes = flatten(turn.attributes);
    // A turn's cost is the sum of its child chat spans, which the draft says this attribute
    // must not include. The sum remains available as the extension attribute.
    assert.equal("gen_ai.usage.cost.amount" in attributes, false);
    assert.equal("gen_ai.usage.cost.currency" in attributes, false);
    assert.equal("gen_ai.usage.cost.source" in attributes, false);
    assert.ok(Number(attributes["codex.usage.cost"]) > 0);
  }
});

test("CAT_OTEL_COST_BREAKDOWN=1 adds the per-class breakdown of issue #484", async () => {
  const broken = await collect({ CAT_OTEL_COST_BREAKDOWN: "1" });
  const first = sortByStart(broken.spans.get("chat") ?? [])[0];
  assert.ok(first);
  const attributes = flatten(first.attributes);
  const classes = {
    "gen_ai.usage.cost.input": (2_000 * 1.25) / 1_000_000,
    "gen_ai.usage.cost.cache_read": (8_000 * 0.125) / 1_000_000,
    "gen_ai.usage.cost.cache_write": 0,
    "gen_ai.usage.cost.output": (500 * 10.0) / 1_000_000,
  };
  for (const [key, value] of Object.entries(classes)) {
    assert.ok(Math.abs(Number(attributes[key]) - value) < 1e-9, `${key}=${attributes[key]}`);
  }
  // The classes are additive: they add up to the amount rather than overlapping it.
  const sum = Object.values(classes).reduce((total, item) => total + item, 0);
  assert.ok(Math.abs(Number(attributes["gen_ai.usage.cost.amount"]) - sum) < 1e-9);
});

test("CAT_OTEL_COST_SEMCONV=0 drops the draft names but keeps the extensions", async () => {
  const off = await collect({ CAT_OTEL_COST_SEMCONV: "0" });
  const first = sortByStart(off.spans.get("chat") ?? [])[0];
  assert.ok(first);
  const attributes = flatten(first.attributes);
  assert.equal("gen_ai.usage.cost.amount" in attributes, false);
  assert.equal("gen_ai.usage.cost.currency" in attributes, false);
  assert.equal("gen_ai.usage.cost.source" in attributes, false);
  assert.ok(Number(attributes["codex.usage.cost"]) > 0);
  assert.equal(attributes["codex.usage.cost.currency"], "USD");
  // The metric goes with them; the other metrics keep flowing.
  const names = new Set(off.metrics.map((item) => item.name));
  assert.equal(names.has("gen_ai.client.operation.cost"), false);
  assert.equal(names.has("gen_ai.client.operation.duration"), true);
});

test("attributes in the registry use gen_ai.* rather than a custom name", () => {
  const first = byStart("chat")[0];
  assert.ok(first);
  const attributes = flatten(first.attributes);
  // The CLI's version is the agent version.
  assert.equal(attributes["gen_ai.agent.version"], "0.149.0");
  assert.equal(attributes["gen_ai.agent.name"], "codex");
  // gen_ai.operation.name fully expresses the kind of span, so no custom attribute exists.
  for (const removed of [
    "agent.span.kind",
    "codex.span.kind",
    "agent.runtime",
    "codex.session.id",
    "codex.cli.version",
  ]) {
    assert.equal(removed in attributes, false, removed);
  }
  // Only information the registry cannot express stays in a custom attribute.
  assert.equal(attributes["codex.originator"], "codex-tui");
  assert.equal(attributes["codex.cwd"], "/repo");
  assert.equal(Number(attributes["codex.model.context_window"]), 258_400);
  assert.ok(String(attributes["codex.turn.id"]).length > 0);
});

test("the second request reports the delta, not the cumulative total", () => {
  const second = byStart("chat")[1];
  assert.ok(second);
  const attributes = flatten(second.attributes);
  assert.equal(Number(attributes["gen_ai.usage.input_tokens"]), 12_000);
  assert.equal(Number(attributes["gen_ai.usage.output_tokens"]), 200);
});

test("each LLM request span carries that call's input / output messages", () => {
  const [first, second] = byStart("chat");
  assert.ok(first);
  assert.ok(second);

  const firstAttributes = flatten(first.attributes);
  const firstInput = JSON.parse(String(firstAttributes["gen_ai.input.messages"]));
  const firstOutput = JSON.parse(String(firstAttributes["gen_ai.output.messages"]));
  assert.deepEqual(firstInput.map((message: { role: string }) => message.role), ["system", "user"]);
  assert.equal(firstInput[1].parts[0].content, "トークンとコストを OTel に出して");
  assert.equal(firstOutput[0].role, "assistant");
  assert.equal(firstOutput[0].parts[0].content, "確認します");
  assert.equal(firstOutput[1].parts[0].type, "tool_call");
  assert.equal(firstOutput[1].parts[0].name, "exec_command");
  assert.equal(
    firstOutput.some((message: { role: string }) => message.role === "tool"),
    false,
  );

  const secondAttributes = flatten(second.attributes);
  const secondInput = JSON.parse(String(secondAttributes["gen_ai.input.messages"]));
  const secondOutput = JSON.parse(String(secondAttributes["gen_ai.output.messages"]));
  assert.ok(secondInput.some((message: { role: string }) => message.role === "tool"));
  assert.equal(secondInput.at(-1).parts[0].content, "続けて");
  assert.equal(secondOutput[0].parts[0].content, "完了しました");
});

test("the turn span carries the message content", () => {
  const turn = group("invoke_agent").find((item) => "gen_ai.input.messages" in flatten(item.attributes));
  assert.ok(turn);
  const attributes = flatten(turn.attributes);
  const input = JSON.parse(String(attributes["gen_ai.input.messages"]));
  assert.equal(input[0].parts[0].content, "トークンとコストを OTel に出して");
  const output = JSON.parse(String(attributes["gen_ai.output.messages"]));
  assert.equal(output[0].role, "assistant");
  assert.equal(output[0].parts[0].content, "出しました");
  assert.equal(Number(attributes["codex.llm.request.count"]), 1);
  assert.equal(Number(attributes["codex.tool.call.count"]), 2);
});

const INFERENCE_EVENT = "gen_ai.client.inference.operation.details";

test("the default (attribute) mode emits no trace event", () => {
  for (const item of [...group("chat"), ...group("invoke_agent"), ...group("execute_tool")]) {
    assert.equal(item.events, undefined, item.name);
  }
});

test("MESSAGES_MODE=event puts content on the trace event as a structured value", () => {
  const chat = fromMode(eventMode, "chat")[0];
  assert.ok(chat);

  // The content disappears from the span attributes.
  const attributes = flatten(chat.attributes);
  assert.equal("gen_ai.input.messages" in attributes, false);
  assert.equal("gen_ai.output.messages" in attributes, false);

  const event = eventAttributes(chat, INFERENCE_EVENT);
  assert.ok(event, JSON.stringify(chat.events));
  assert.equal(chat.events?.[0]?.timeUnixNano, chat.endTimeUnixNano);
  // The semconv Required attributes are complete on the event by itself.
  assert.equal(event["gen_ai.operation.name"], "chat");
  assert.equal(event["gen_ai.provider.name"], "openai");
  assert.equal(event["gen_ai.conversation.id"], SESSION_ID);
  assert.equal(event["gen_ai.request.model"], MODEL);
  assert.equal(event["gen_ai.response.model"], MODEL);

  // Decodes as arrayValue / kvlistValue rather than a JSON string.
  const input = event["gen_ai.input.messages"] as Message[];
  assert.deepEqual(input.map((message) => message.role), ["system", "user"]);
  assert.equal(input[1]?.parts[0]?.["content"], "トークンとコストを OTel に出して");
  const output = event["gen_ai.output.messages"] as Message[];
  assert.equal(output[0]?.role, "assistant");
  assert.equal(output[0]?.parts[0]?.["content"], "確認します");
  assert.equal(output[1]?.parts[0]?.["type"], "tool_call");
  assert.equal(output[1]?.parts[0]?.["name"], "exec_command");
});

test("MESSAGES_MODE=event moves every event-defined attribute, not just content, to the event", () => {
  const chat = fromMode(eventMode, "chat")[0];
  assert.ok(chat);
  const attributes = flatten(chat.attributes);
  const event = eventAttributes(chat, INFERENCE_EVENT);
  assert.ok(event);

  // Token attributes defined on the event move to the event.
  assert.equal(Number(event["gen_ai.usage.input_tokens"]), 10_000);
  assert.equal(Number(event["gen_ai.usage.output_tokens"]), 500);
  assert.equal(Number(event["gen_ai.usage.cache_read.input_tokens"]), 8_000);
  assert.equal("gen_ai.usage.input_tokens" in attributes, false);
  assert.equal("gen_ai.usage.output_tokens" in attributes, false);
  assert.equal("gen_ai.usage.cache_read.input_tokens" in attributes, false);
  assert.equal("gen_ai.response.model" in attributes, false);

  // Every key semconv defines on the event moves there, reasoning tokens included.
  assert.equal(event["gen_ai.request.reasoning.level"], "medium");
  assert.equal(Number(event["gen_ai.usage.reasoning.output_tokens"]), 300);
  assert.equal("gen_ai.request.reasoning.level" in attributes, false);
  assert.equal("gen_ai.usage.reasoning.output_tokens" in attributes, false);

  // Attributes Required / Conditionally Required on the span stay on the span too.
  assert.equal(attributes["gen_ai.operation.name"], "chat");
  assert.equal(attributes["gen_ai.provider.name"], "openai");
  assert.equal(attributes["gen_ai.conversation.id"], SESSION_ID);
  assert.equal(attributes["gen_ai.request.model"], MODEL);

  // The draft defines its cost attributes on the event as well, so they move with the rest.
  assert.ok(Number(event["gen_ai.usage.cost.amount"]) > 0);
  assert.equal(event["gen_ai.usage.cost.currency"], "USD");
  assert.equal(event["gen_ai.usage.cost.source"], "local");
  assert.equal("gen_ai.usage.cost.amount" in attributes, false);

  // Extensions absent from semconv (cost and custom attributes) remain span attributes.
  assert.equal(attributes["codex.usage.cost.currency"], "USD");
  assert.ok(Number(attributes["codex.usage.cost"]) > 0);
  assert.equal(Number(attributes["codex.usage.total_tokens"]), 10_500);
  assert.equal(Number(attributes["codex.usage.uncached_input_tokens"]), 2_000);
  assert.equal(attributes["session.id"], SESSION_ID);
  assert.equal("codex.usage.cost" in event, false);
  assert.equal("codex.usage.total_tokens" in event, false);
  assert.equal("session.id" in event, false);
});

test("with MESSAGES_MODE=event, the SessionEnd turn span has an event too", () => {
  // A turn span collected without a Stop has no content, but routes attributes the same way.
  const turns = fromMode(eventMode, "invoke_agent");
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    const event = eventAttributes(turn, INFERENCE_EVENT);
    assert.ok(event, turn.spanId);
    assert.equal(event["gen_ai.operation.name"], "invoke_agent");
    assert.ok(Number(event["gen_ai.usage.input_tokens"]) > 0);
    assert.equal("gen_ai.usage.input_tokens" in flatten(turn.attributes), false);
  }
});

test("with MESSAGES_MODE=event, the turn span has a trace event as well", () => {
  const turn = fromMode(eventMode, "invoke_agent").find((item) =>
    eventAttributes(item, INFERENCE_EVENT)?.["gen_ai.input.messages"] !== undefined,
  );
  assert.ok(turn);
  assert.equal("gen_ai.input.messages" in flatten(turn.attributes), false);

  const event = eventAttributes(turn, INFERENCE_EVENT);
  assert.ok(event);
  assert.equal(event["gen_ai.operation.name"], "invoke_agent");
  const input = event["gen_ai.input.messages"] as Message[];
  assert.equal(input[0]?.parts[0]?.["content"], "トークンとコストを OTel に出して");
  const output = event["gen_ai.output.messages"] as Message[];
  assert.equal(output[0]?.role, "assistant");
  assert.equal(output[0]?.parts[0]?.["content"], "出しました");
});

test("MESSAGES_MODE=both populates the span attributes and the trace event", () => {
  const chat = fromMode(bothMode, "chat")[0];
  assert.ok(chat);
  const attributes = flatten(chat.attributes);
  const fromAttribute = JSON.parse(String(attributes["gen_ai.input.messages"])) as Message[];
  const event = eventAttributes(chat, INFERENCE_EVENT);
  assert.ok(event);
  // The same content appears twice: as a JSON string and as a structured value.
  assert.deepEqual(event["gen_ai.input.messages"], fromAttribute);
  assert.deepEqual(
    event["gen_ai.output.messages"],
    JSON.parse(String(attributes["gen_ai.output.messages"])),
  );

  // The other event-defined attributes appear in both places, under the same semconv names.
  assert.equal(Number(attributes["gen_ai.usage.input_tokens"]), 10_000);
  assert.equal(Number(event["gen_ai.usage.input_tokens"]), 10_000);
  assert.equal(attributes["gen_ai.request.reasoning.level"], "medium");
  assert.equal(event["gen_ai.request.reasoning.level"], "medium");
  assert.equal(Number(attributes["gen_ai.usage.reasoning.output_tokens"]), 300);
  assert.equal(Number(event["gen_ai.usage.reasoning.output_tokens"]), 300);
});

test("tool spans are unaffected by where content is placed", () => {
  for (const mode of [eventMode, bothMode]) {
    const tool = fromMode(mode, "execute_tool").find(
      (item) => flatten(item.attributes)["gen_ai.tool.call.id"] === "call_test_tool",
    );
    assert.ok(tool);
    const attributes = flatten(tool.attributes);
    assert.equal(JSON.parse(String(attributes["gen_ai.tool.call.arguments"])).cmd, "printf test");
    assert.equal(tool.events, undefined);
  }
});

/** Collects every data point for one metric name, across all deliveries. */
function dataPoints(name: string, from: readonly OtlpMetric[] = metrics): OtlpHistogramPoint[] {
  return from.filter((item) => item.name === name).flatMap((item) => item.histogram.dataPoints);
}

/** Filters data points by attribute and sums their count and sum. */
function totals(
  name: string,
  match: Attributes = {},
  from: readonly OtlpMetric[] = metrics,
): { count: number; sum: number; points: number } {
  const selected = dataPoints(name, from).filter((point) => {
    const attributes = flatten(point.attributes);
    return Object.entries(match).every(([key, value]) => attributes[key] === value);
  });
  return {
    count: selected.reduce((total, point) => total + Number(point.count), 0),
    sum: selected.reduce((total, point) => total + point.sum, 0),
    points: selected.length,
  };
}

test("sends the semconv GenAI metrics to /v1/metrics", () => {
  const metricPaths = new Set(
    deliveries.filter((item) => "resourceMetrics" in item.body).map((item) => item.path),
  );
  const tracePaths = new Set(
    deliveries.filter((item) => "resourceSpans" in item.body).map((item) => item.path),
  );
  assert.deepEqual([...metricPaths], ["/v1/metrics"]);
  assert.deepEqual([...tracePaths], ["/v1/traces"]);

  const names = new Set(metrics.map((item) => item.name));
  assert.deepEqual(
    [...names].sort(),
    [
      "gen_ai.client.operation.cost",
      "gen_ai.client.operation.duration",
      "gen_ai.client.token.usage",
      "gen_ai.execute_tool.duration",
      "gen_ai.invoke_agent.duration",
      "gen_ai.invoke_agent.inference_calls",
      "gen_ai.invoke_agent.tool_calls",
    ],
    [...names].join(","),
  );

  // Unit and temporality (1 = DELTA). The process is throwaway, so cumulative is impossible.
  const units = new Map(metrics.map((item) => [item.name, item.unit]));
  assert.equal(units.get("gen_ai.client.token.usage"), "{token}");
  assert.equal(units.get("gen_ai.client.operation.duration"), "s");
  // The draft carries the currency in an attribute, so the unit is the unitless {cost}.
  assert.equal(units.get("gen_ai.client.operation.cost"), "{cost}");
  assert.equal(units.get("gen_ai.invoke_agent.inference_calls"), "{inference_call}");
  assert.equal(units.get("gen_ai.invoke_agent.tool_calls"), "{tool_call}");
  for (const metric of metrics) {
    assert.equal(metric.histogram.aggregationTemporality, 1, metric.name);
  }
});

test("histogram buckets agree with the boundaries", () => {
  for (const metric of metrics) {
    for (const point of metric.histogram.dataPoints) {
      assert.equal(point.bucketCounts.length, point.explicitBounds.length + 1, metric.name);
      const inBuckets = point.bucketCounts.reduce((total, item) => total + Number(item), 0);
      assert.equal(inBuckets, Number(point.count), metric.name);
      assert.ok(BigInt(point.startTimeUnixNano) <= BigInt(point.timeUnixNano), metric.name);
      assert.ok(point.min <= point.max, metric.name);
    }
  }
});

test("gen_ai.client.token.usage reports input and output separately", () => {
  const input = totals("gen_ai.client.token.usage", { "gen_ai.token.type": "input" });
  const output = totals("gen_ai.client.token.usage", { "gen_ai.token.type": "output" });
  // Two requests: 10000 + 12000 in, 500 + 200 out.
  assert.equal(input.count, 2);
  assert.equal(input.sum, 22_000);
  assert.equal(output.count, 2);
  assert.equal(output.sum, 700);

  const point = dataPoints("gen_ai.client.token.usage")[0];
  assert.ok(point);
  const attributes = flatten(point.attributes);
  assert.equal(attributes["gen_ai.operation.name"], "chat");
  assert.equal(attributes["gen_ai.provider.name"], "openai");
  assert.equal(attributes["gen_ai.request.model"], MODEL);
  assert.equal(attributes["gen_ai.response.model"], MODEL);
});

test("gen_ai.client.operation.cost reports one point per request", () => {
  const cost = totals("gen_ai.client.operation.cost");
  // The same two requests as the token metric.
  assert.equal(cost.count, 2);
  const first = (2_000 * 1.25 + 8_000 * 0.125 + 500 * 10.0) / 1_000_000;
  const second = (3_000 * 1.25 + 9_000 * 0.125 + 200 * 10.0) / 1_000_000;
  assert.ok(Math.abs(cost.sum - (first + second)) < 1e-9, String(cost.sum));

  const point = dataPoints("gen_ai.client.operation.cost")[0];
  assert.ok(point);
  const attributes = flatten(point.attributes);
  assert.equal(attributes["gen_ai.operation.name"], "chat");
  assert.equal(attributes["gen_ai.provider.name"], "openai");
  assert.equal(attributes["gen_ai.request.model"], MODEL);
  // Required on this metric in the draft: the amount is meaningless without it.
  assert.equal(attributes["gen_ai.usage.cost.currency"], "USD");
  assert.equal(attributes["gen_ai.usage.cost.source"], "local");
});

test("metric attributes carry no high-cardinality identifiers", () => {
  for (const metric of metrics) {
    for (const point of metric.histogram.dataPoints) {
      for (const key of Object.keys(flatten(point.attributes))) {
        assert.ok(
          !["session.id", "gen_ai.conversation.id", "codex.turn.id", "gen_ai.tool.call.id"].includes(
            key,
          ),
          `${metric.name} carries ${key}`,
        );
        assert.ok(!key.startsWith("codex."), `${metric.name} carries ${key}`);
      }
    }
  }
});

test("the invoke_agent metrics report per-turn counts", () => {
  // The Stop turn (1 chat, 2 tools) and the SessionEnd turn (1 chat, 0 tools).
  const inference = totals("gen_ai.invoke_agent.inference_calls", {
    "gen_ai.agent.name": "codex",
  });
  assert.equal(inference.count, 2);
  assert.equal(inference.sum, 2);
  const tools = totals("gen_ai.invoke_agent.tool_calls", { "gen_ai.agent.name": "codex" });
  assert.equal(tools.count, 2);
  assert.equal(tools.sum, 2);
  assert.equal(totals("gen_ai.invoke_agent.duration").count, 2);
});

test("execute_tool.duration separates success from failure via error.type", () => {
  const points = dataPoints("gen_ai.execute_tool.duration");
  assert.equal(points.length, 2, JSON.stringify(points.map((item) => flatten(item.attributes))));
  const succeeded = points.find((item) => !("error.type" in flatten(item.attributes)));
  const failed = points.find((item) => flatten(item.attributes)["error.type"] === "_OTHER");
  assert.ok(succeeded);
  assert.ok(failed);
  const attributes = flatten(succeeded.attributes);
  assert.equal(attributes["gen_ai.tool.name"], "exec_command");
  assert.equal(attributes["gen_ai.tool.type"], "function");
  assert.equal(attributes["gen_ai.agent.name"], "codex");
  // In the synthetic rollout, function_call → output takes 250ms and 100ms.
  assert.ok(Math.abs(succeeded.sum - 0.25) < 1e-6, String(succeeded.sum));
  assert.ok(Math.abs(failed.sum - 0.1) < 1e-6, String(failed.sum));
});

test("CAT_OTEL_METRICS=0 sends no metrics", async () => {
  const off = await collect({ CAT_OTEL_METRICS: "0" });
  assert.equal(off.metrics.length, 0);
  // Traces are still sent.
  assert.equal(off.spans.get("chat")?.length, 2);
});

test("resource attributes", () => {
  const first = received[0];
  assert.ok(first);
  const resource = flatten(first.resourceSpans[0]!.resource.attributes);
  assert.equal(resource["service.name"], "codex-test");
  assert.equal(resource["deployment.environment.name"], "test");
});

/** The resource attributes of every /v1/metrics delivery. */
function metricResources(from: readonly Delivery[]): Attributes[] {
  return from
    .filter((item) => "resourceMetrics" in item.body)
    .flatMap((item) =>
      (item.body as unknown as OtlpMetricEnvelope).resourceMetrics.map((resourceMetric) =>
        flatten(resourceMetric.resource.attributes),
      ),
    );
}

test("the configured resource attributes reach the metric data points", () => {
  const resources = metricResources(deliveries);
  assert.ok(resources.length > 0);
  for (const resource of resources) {
    assert.equal(resource["service.name"], "codex-test");
    assert.equal(resource["deployment.environment.name"], "test");
  }
  // A backend that ignores resource attributes on metrics can still group by them only if
  // they are on the data points too.
  for (const metric of metrics) {
    for (const point of metric.histogram.dataPoints) {
      assert.equal(
        flatten(point.attributes)["deployment.environment.name"],
        "test",
        `${metric.name} lost the resource attribute`,
      );
    }
  }
});

test("CAT_OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=0 keeps them off the data points", async () => {
  const off = await collect({ CAT_OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "0" });
  assert.ok(off.metrics.length > 0);
  for (const metric of off.metrics) {
    for (const point of metric.histogram.dataPoints) {
      assert.ok(
        !("deployment.environment.name" in flatten(point.attributes)),
        `${metric.name} carries the resource attribute`,
      );
    }
  }
  // Only the data points lose them; the resource still carries them.
  for (const resource of metricResources(off.deliveries)) {
    assert.equal(resource["deployment.environment.name"], "test");
  }
});
