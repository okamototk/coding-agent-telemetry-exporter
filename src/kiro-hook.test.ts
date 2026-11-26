import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { processPayload } from "./otel-genai-hook.ts";
import type { HookPayload } from "./core/types.ts";

// src/*.test.ts exercises src/*.ts; dist/*.test.js exercises dist/*.js.
const SELF = fileURLToPath(import.meta.url);
const HOOK = join(dirname(SELF), `otel-genai-hook${SELF.endsWith(".ts") ? ".ts" : ".js"}`);

interface Attribute {
  key: string;
  value: Record<string, unknown>;
}

interface CapturedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status?: { code: number; message: string };
}

interface CapturedPoint {
  count: string;
  sum: number;
  attributes: Attribute[];
}

interface CapturedMetric {
  name: string;
  unit: string;
  histogram: { aggregationTemporality: number; dataPoints: CapturedPoint[] };
}

type Flat = Record<string, string | number | boolean>;

function flatten(attributes: Attribute[]): Flat {
  return Object.fromEntries(
    attributes.map((attribute) => [
      attribute.key,
      Object.values(attribute.value)[0] as string | number | boolean,
    ]),
  );
}

interface Collector {
  server: Server;
  port: number;
  envelopes: Record<string, unknown>[];
}

async function collector(): Promise<Collector> {
  const envelopes: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      envelopes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { server, port: address.port, envelopes };
}

function harvest(envelopes: readonly Record<string, unknown>[]): {
  spans: CapturedSpan[];
  metrics: CapturedMetric[];
  resource: Flat | null;
} {
  const spans: CapturedSpan[] = [];
  const metrics: CapturedMetric[] = [];
  let resource: Flat | null = null;
  for (const envelope of envelopes) {
    const resourceSpans = (envelope["resourceSpans"] ?? []) as {
      resource: { attributes: Attribute[] };
      scopeSpans: { spans: CapturedSpan[] }[];
    }[];
    for (const item of resourceSpans) {
      resource ??= flatten(item.resource.attributes);
      for (const scope of item.scopeSpans) {
        spans.push(...scope.spans);
      }
    }
    const resourceMetrics = (envelope["resourceMetrics"] ?? []) as {
      scopeMetrics: { metrics: CapturedMetric[] }[];
    }[];
    for (const item of resourceMetrics) {
      for (const scope of item.scopeMetrics) {
        metrics.push(...scope.metrics);
      }
    }
  }
  return { spans, metrics, resource };
}

function totals(
  metrics: readonly CapturedMetric[],
  name: string,
  match: Flat = {},
): { count: number; sum: number } {
  const points = metrics
    .filter((metric) => metric.name === name)
    .flatMap((metric) => metric.histogram.dataPoints)
    .filter((point) => {
      const attributes = flatten(point.attributes);
      return Object.entries(match).every(([key, value]) => attributes[key] === value);
    });
  return {
    count: points.reduce((total, point) => total + Number(point.count), 0),
    sum: points.reduce((total, point) => total + point.sum, 0),
  };
}

interface TokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface TurnInput {
  requests: number;
  tools: number;
  credits: number[];
  endIso: string;
  durationSec: number;
  tokens?: TokenCounts;
  failure?: string;
}

/** One `user_turn_metadatas` entry, in the shape Kiro CLI 2.22 writes. */
function turnMetadata(input: TurnInput): Record<string, unknown> {
  return {
    loop_id: { agent_id: { name: "kiro_default", parent_id: null, rand: null }, rand: 1 },
    result: input.failure === undefined ? { Ok: { id: "a", role: "assistant" } } : { Err: input.failure },
    message_ids: [],
    total_request_count: input.requests,
    number_of_cycles: input.tools,
    builtin_tool_uses: input.tools,
    turn_duration: { secs: input.durationSec, nanos: 0 },
    end_reason: input.failure === undefined ? "UserTurnEnd" : "Error",
    end_timestamp: input.endIso,
    input_token_count: input.tokens?.input ?? 0,
    output_token_count: input.tokens?.output ?? 0,
    cache_read_input_token_count: input.tokens?.cacheRead ?? 0,
    cache_write_input_token_count: input.tokens?.cacheWrite ?? 0,
    model: "auto",
    assistant_response_length: 4,
    request_attempts: input.requests + 1,
    context_usage_percentage: 1.25,
    final_context_usage_percentage: 1.5,
    metering_usage: input.credits.map((value) => ({
      value,
      unit: "credit",
      unitPlural: "credits",
    })),
    user_prompt_length: 10,
  };
}

function sessionStore(sessionId: string, turns: Record<string, unknown>[]): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: "/repo",
    created_at: "2026-09-17T10:00:00.000000000Z",
    updated_at: "2026-09-17T10:05:00.000000000Z",
    title: "調査して",
    session_created_reason: "user",
    session_state: {
      version: "v1",
      conversation_metadata: { user_turn_metadatas: turns },
      rts_model_state: {
        conversation_id: sessionId,
        model_info: { model_id: "auto", context_window_tokens: 200000 },
      },
      agent_name: "otel-demo",
    },
  });
}

interface Sandbox {
  sessions: string;
  state: string;
  restore: () => void;
}

/** An ambient CAT_OTEL_* would change what the hook emits, so the run starts with none set. */
function sandbox(port: number, workdir: string, extra: Record<string, string> = {}): Sandbox {
  const previous = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CAT_OTEL_")) {
      delete process.env[name];
    }
  }
  const sessions = join(workdir, "sessions");
  const state = join(workdir, "state");
  mkdirSync(sessions, { recursive: true });
  process.env["CAT_OTEL_ENDPOINT"] = `http://127.0.0.1:${port}`;
  process.env["CAT_OTEL_STATE_DIR"] = state;
  process.env["CAT_OTEL_KIRO_SESSIONS_DIR"] = sessions;
  // The store is written by the test before `stop`, so no waiting is needed.
  process.env["CAT_OTEL_KIRO_STORE_WAIT_MS"] = "0";
  Object.assign(process.env, extra);
  return {
    sessions,
    state,
    restore: () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    },
  };
}

const shellCall = { command: "printf ok", __tool_use_purpose: "check" };
const readCall = { path: "/repo/missing" };

/**
 * Hook timestamps come from Date.now(), so events have to land in distinct milliseconds for
 * the tool windows to have any width. Real tool executions take far longer than this.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

async function run(payload: HookPayload): Promise<void> {
  await tick();
  await processPayload(payload, "kiro");
}

test("Kiro hooks and the session store become one turn trace", async () => {
  const sessionId = "kiro-session-1";
  const captured = await collector();
  const workdir = mkdtempSync(join(tmpdir(), "kiro-otel-hook-"));
  const box = sandbox(captured.port, workdir, { CAT_OTEL_KIRO_CREDIT_USD: "0.01" });
  const store = join(box.sessions, `${sessionId}.json`);
  const base = { session_id: sessionId, cwd: "/repo" };

  try {
    process.env["KIRO_SESSION_ID"] = sessionId;
    // Kiro's agentSpawn payload carries cwd only; the session id comes from the environment.
    writeFileSync(store, sessionStore(sessionId, []), "utf8");
    await run({ hook_event_name: "agentSpawn", cwd: "/repo" });
    await run({ ...base, hook_event_name: "userPromptSubmit", prompt: "調査して" });

    // Two tool batches, so the agent loop made three LLM requests.
    await run({ ...base, hook_event_name: "preToolUse", tool_name: "shell", tool_input: shellCall });
    await run({
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "shell",
      tool_input: shellCall,
      tool_response: { items: [{ Json: { exit_status: "exit status: 0", stdout: "ok", stderr: "" } }] },
    });
    await run({ ...base, hook_event_name: "preToolUse", tool_name: "fs_read", tool_input: readCall });
    await run({
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "fs_read",
      tool_input: readCall,
      // A non-zero exit is still a "completed" tool call for Kiro; the status is in the body.
      tool_response: { items: [{ Json: { exit_status: "exit status: 2", stdout: "", stderr: "no such file" } }] },
    });

    // Kiro appends the turn metadata as the turn ends, just after it starts the stop hook.
    await tick();
    writeFileSync(
      store,
      sessionStore(sessionId, [
        turnMetadata({
          requests: 3,
          tools: 2,
          credits: [0.05, 0.03, 0.02],
          endIso: new Date().toISOString(),
          durationSec: 120,
        }),
      ]),
      "utf8",
    );
    await run({ ...base, hook_event_name: "stop", assistant_response: "完了" });
  } finally {
    box.restore();
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => captured.server.close(() => resolve()));
  }

  const { spans, metrics, resource } = harvest(captured.envelopes);
  const byKind = (operation: string): CapturedSpan[] =>
    spans.filter((span) => flatten(span.attributes)["gen_ai.operation.name"] === operation);
  assert.equal(byKind("chat").length, 3);
  assert.equal(byKind("execute_tool").length, 2);
  assert.equal(byKind("invoke_agent").length, 1);
  assert.equal(resource?.["service.name"], "kiro-cli");

  const turn = byKind("invoke_agent")[0];
  assert.ok(turn);
  const turnAttrs = flatten(turn.attributes);
  // The agent is the one the session runs, which Kiro names in the session store.
  assert.equal(turn.name, "invoke_agent otel-demo");
  assert.equal(turnAttrs["gen_ai.agent.name"], "otel-demo");
  // Kiro fronts several model families, so neither openai nor anthropic describes it.
  assert.equal(turnAttrs["gen_ai.provider.name"], "kiro");
  assert.equal(turnAttrs["gen_ai.conversation.id"], sessionId);
  assert.equal(turnAttrs["kiro.turn.id"], "t1");
  assert.equal(Number(turnAttrs["kiro.llm.request.count"]), 3);
  assert.equal(Number(turnAttrs["kiro.tool.call.count"]), 2);
  assert.equal(Number(turnAttrs["kiro.llm.request.attempts"]), 4);
  assert.equal(Number(turnAttrs["kiro.model.context_window"]), 200000);
  assert.equal(Number(turnAttrs["kiro.context.usage_percentage"]), 1.5);
  assert.equal(turnAttrs["kiro.turn.end_reason"], "UserTurnEnd");
  // Credits are what Kiro actually metered, and the only usage figure it reports.
  assert.equal(Number(turnAttrs["kiro.usage.credits"]).toFixed(2), "0.10");
  assert.equal(Number(turnAttrs["kiro.usage.cost"]).toFixed(4), "0.0010");
  // A credit-metered account reports no token counts, and a zero there would read as free.
  for (const key of [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "kiro.usage.total_tokens",
  ]) {
    assert.equal(key in turnAttrs, false, key);
  }
  // As for the other runtimes, the turn span leaves the model to an extension attribute.
  assert.equal("gen_ai.request.model" in turnAttrs, false);
  assert.equal(turnAttrs["kiro.turn.model"], "auto");

  for (const child of [...byKind("chat"), ...byKind("execute_tool")]) {
    assert.equal(child.traceId, turn.traceId);
    assert.equal(child.parentSpanId, turn.spanId);
  }

  const chats = byKind("chat").sort(
    (left, right) => Number(BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano)),
  );
  const chatAttrs = chats.map((span) => flatten(span.attributes));
  assert.deepEqual(
    chatAttrs.map((item) => Number(item["kiro.usage.credits"]).toFixed(2)),
    ["0.05", "0.03", "0.02"],
  );
  // The draft cost attributes, derived from the credits via CAT_OTEL_KIRO_CREDIT_USD.
  assert.equal(Number(chatAttrs[0]?.["gen_ai.usage.cost.amount"]).toFixed(4), "0.0005");
  assert.equal(chatAttrs[0]?.["gen_ai.usage.cost.currency"], "USD");
  assert.equal(chatAttrs[0]?.["gen_ai.usage.cost.source"], "local");
  assert.equal(chatAttrs[0]?.["gen_ai.request.model"], "auto");
  // No token counts were reported, so nothing was apportioned either.
  assert.equal("kiro.usage.tokens.apportioned" in (chatAttrs[0] ?? {}), false);
  // A metered amount has no per-token-rate split, and no rate table was consulted.
  for (const key of [
    "kiro.usage.input_cost",
    "kiro.usage.output_cost",
    "kiro.usage.cost.pricing_matched",
  ]) {
    assert.equal(key in (chatAttrs[0] ?? {}), false, key);
  }

  // The request spans sit in the gaps the tool executions leave: two batches, three gaps.
  const window = (span: CapturedSpan): [bigint, bigint] => [
    BigInt(span.startTimeUnixNano),
    BigInt(span.endTimeUnixNano),
  ];
  const [turnStart, turnEnd] = window(turn);
  for (const tool of byKind("execute_tool")) {
    const [toolStart, toolEnd] = window(tool);
    assert.ok(toolStart >= turnStart && toolEnd <= turnEnd, "tool runs inside the turn");
    for (const chat of chats) {
      const [chatStart, chatEnd] = window(chat);
      assert.ok(chatEnd <= toolStart || chatStart >= toolEnd, "no request overlaps a tool");
    }
  }
  assert.equal(new Set(chats.map((span) => span.startTimeUnixNano)).size, 3);

  const failed = byKind("execute_tool")
    .map((span) => ({ span, attributes: flatten(span.attributes) }))
    .find((item) => item.attributes["gen_ai.tool.name"] === "fs_read");
  assert.ok(failed);
  // A non-zero exit is an error, with the text on the status and the well-known fallback
  // value on the attribute.
  assert.equal(failed.attributes["error.type"], "_OTHER");
  assert.equal(failed.span.status?.code, 2);
  assert.match(failed.span.status?.message ?? "", /code 2/);
  assert.equal(failed.attributes["gen_ai.tool.type"], "function");
  // Kiro issues no tool call id, so none is invented.
  assert.equal("gen_ai.tool.call.id" in failed.attributes, false);
  // Tool spans are sent before any turn metadata exists, but the store names the agent from
  // the session's first moment, so they carry the same agent name as the turn.
  assert.equal(failed.attributes["gen_ai.agent.name"], "otel-demo");
  const ok = byKind("execute_tool")
    .map((span) => flatten(span.attributes))
    .find((item) => item["gen_ai.tool.name"] === "shell");
  assert.equal("error.type" in (ok ?? {}), false);

  // Credits get their own metric: they are neither tokens nor money.
  const credits = totals(metrics, "kiro.client.credit.usage");
  assert.equal(credits.count, 3);
  assert.equal(credits.sum.toFixed(2), "0.10");
  assert.equal(
    metrics.find((metric) => metric.name === "kiro.client.credit.usage")?.unit,
    "{credit}",
  );
  // No token counts were reported, so no token point is sent at all.
  assert.equal(totals(metrics, "gen_ai.client.token.usage").count, 0);
  assert.equal(totals(metrics, "gen_ai.client.operation.duration").count, 3);
  assert.equal(totals(metrics, "gen_ai.client.operation.cost").count, 3);
  const inference = totals(metrics, "gen_ai.invoke_agent.inference_calls", {
    "gen_ai.agent.name": "otel-demo",
  });
  assert.equal(inference.count, 1);
  assert.equal(inference.sum, 3);
  assert.equal(totals(metrics, "gen_ai.invoke_agent.tool_calls").sum, 2);
  assert.equal(totals(metrics, "gen_ai.execute_tool.duration").count, 2);
  assert.equal(
    totals(metrics, "gen_ai.execute_tool.duration", { "error.type": "_OTHER" }).count,
    1,
  );
});

test("reported token counts are apportioned over the turn's requests", async () => {
  const sessionId = "kiro-session-2";
  const captured = await collector();
  const workdir = mkdtempSync(join(tmpdir(), "kiro-otel-hook-"));
  const box = sandbox(captured.port, workdir);
  const store = join(box.sessions, `${sessionId}.json`);
  const base = { session_id: sessionId, cwd: "/repo" };

  try {
    writeFileSync(store, sessionStore(sessionId, []), "utf8");
    await run({ ...base, hook_event_name: "userPromptSubmit", prompt: "ping" });
    writeFileSync(
      store,
      sessionStore(sessionId, [
        turnMetadata({
          requests: 2,
          tools: 0,
          credits: [0.75, 0.25],
          endIso: new Date().toISOString(),
          durationSec: 10,
          tokens: { input: 100, output: 20, cacheRead: 60, cacheWrite: 40 },
          failure: "stream closed",
        }),
      ]),
      "utf8",
    );
    await run({ ...base, hook_event_name: "stop", assistant_response: "pong" });
  } finally {
    box.restore();
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => captured.server.close(() => resolve()));
  }

  const { spans, metrics } = harvest(captured.envelopes);
  const byKind = (operation: string): Flat[] =>
    spans
      .filter((span) => flatten(span.attributes)["gen_ai.operation.name"] === operation)
      .map((span) => flatten(span.attributes));
  const chats = byKind("chat");
  const turn = byKind("invoke_agent")[0];
  assert.equal(chats.length, 2);
  assert.ok(turn);

  // input_tokens is the whole prompt, cache reads and writes included: 100 + 60 + 40.
  assert.equal(Number(turn["gen_ai.usage.input_tokens"]), 200);
  assert.equal(Number(turn["gen_ai.usage.output_tokens"]), 20);
  assert.equal(Number(turn["kiro.usage.total_tokens"]), 220);
  // The cache breakdown is left off the turn span, as it is for the other runtimes.
  assert.equal("gen_ai.usage.cache_read.input_tokens" in turn, false);

  // Kiro reports tokens per turn, so the per-request figures are a credit-weighted estimate,
  // flagged as such and adding up to the turn total exactly.
  const inputs = chats.map((chat) => Number(chat["gen_ai.usage.input_tokens"])).sort((a, b) => b - a);
  assert.deepEqual(inputs, [150, 50]);
  assert.equal(
    chats.reduce((total, chat) => total + Number(chat["gen_ai.usage.output_tokens"]), 0),
    20,
  );
  assert.equal(chats[0]?.["kiro.usage.tokens.apportioned"], true);
  assert.equal(Number(chats[0]?.["gen_ai.usage.cache_read.input_tokens"]), 45);
  assert.equal(Number(turn["kiro.usage.credits"]), 1);
  // With no credit rate configured but tokens on hand, cost falls back to the rate table —
  // and `auto` is not in it, so the fallback rates are flagged as unmatched.
  assert.ok(Number(chats[0]?.["gen_ai.usage.cost.amount"]) > 0);
  assert.equal(chats[0]?.["kiro.usage.cost.pricing_matched"], false);

  // The turn failed, so error.type is set and the message goes on the span status.
  assert.equal(turn["error.type"], "_OTHER");
  assert.equal(turn["kiro.turn.end_reason"], "Error");

  const input = totals(metrics, "gen_ai.client.token.usage", { "gen_ai.token.type": "input" });
  assert.equal(input.count, 2);
  assert.equal(input.sum, 200);
  assert.equal(totals(metrics, "gen_ai.invoke_agent.duration", { "error.type": "_OTHER" }).count, 1);
});

/** Runs the real hook once, as Kiro would. Its stdout must stay empty: Kiro feeds whatever a
 * hook prints back to the model as additional context. */
function runHook(payload: unknown, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, "--runtime=kiro"], {
      // The real entry point also checks for a newer rate table; keep tests off the network.
      env: { CAT_OTEL_PRICING_UPDATE: "0", ...environment },
      stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
      } catch (error) {
        reject(error as Error);
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("stop is handled by a detached process, after Kiro has written the store", async () => {
  const sessionId = "kiro-session-4";
  const captured = await collector();
  const workdir = mkdtempSync(join(tmpdir(), "kiro-otel-hook-"));
  const sessions = join(workdir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const store = join(sessions, `${sessionId}.json`);
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CAT_OTEL_")),
    ),
    CAT_OTEL_ENDPOINT: `http://127.0.0.1:${captured.port}`,
    CAT_OTEL_STATE_DIR: join(workdir, "state"),
    CAT_OTEL_KIRO_SESSIONS_DIR: sessions,
    CAT_OTEL_KIRO_STORE_WAIT_MS: "10000",
  };

  try {
    // Kiro persists the store only once the stop hook has exited, so the store still holds
    // no finished turn while the hook runs.
    writeFileSync(store, sessionStore(sessionId, []), "utf8");
    const stdout = await runHook(
      { hook_event_name: "stop", session_id: sessionId, cwd: "/repo", assistant_response: "pong" },
      environment,
    );
    assert.equal(stdout, "");
    assert.equal(captured.envelopes.length, 0, "the hook itself exports nothing");

    writeFileSync(
      store,
      sessionStore(sessionId, [
        turnMetadata({
          requests: 1,
          tools: 0,
          credits: [0.04],
          endIso: new Date().toISOString(),
          durationSec: 3,
        }),
      ]),
      "utf8",
    );
    const deadline = Date.now() + 10_000;
    while (captured.envelopes.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => captured.server.close(() => resolve()));
  }

  const { spans } = harvest(captured.envelopes);
  const turn = spans.find(
    (span) => flatten(span.attributes)["gen_ai.operation.name"] === "invoke_agent",
  );
  assert.ok(turn, "the detached process exported the turn once the store appeared");
  assert.equal(Number(flatten(turn.attributes)["kiro.usage.credits"]).toFixed(2), "0.04");
});

test("a turn with no usage in the store is still reported, without inventing any", async () => {
  const sessionId = "kiro-session-5";
  const captured = await collector();
  const workdir = mkdtempSync(join(tmpdir(), "kiro-otel-hook-"));
  const box = sandbox(captured.port, workdir);
  const base = { session_id: sessionId, cwd: "/repo" };

  try {
    // The classic UI never writes the session store at all, so nothing ever lands there.
    await run({ ...base, hook_event_name: "userPromptSubmit", prompt: "ping" });
    await run({ ...base, hook_event_name: "preToolUse", tool_name: "shell", tool_input: shellCall });
    await run({
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "shell",
      tool_input: shellCall,
      tool_response: { items: [{ Json: { exit_status: "exit status: 0" } }] },
    });
    await run({ ...base, hook_event_name: "stop", assistant_response: "pong" });
  } finally {
    box.restore();
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => captured.server.close(() => resolve()));
  }

  const { spans } = harvest(captured.envelopes);
  const kinds = spans.map((span) => flatten(span.attributes)["gen_ai.operation.name"]);
  // The tool span needs a root, so the turn is reported even with its usage unknown; there is
  // nothing to build a chat span from.
  assert.deepEqual(kinds.sort(), ["execute_tool", "invoke_agent"]);
  const turn = spans.find(
    (span) => flatten(span.attributes)["gen_ai.operation.name"] === "invoke_agent",
  );
  assert.ok(turn);
  const attributes = flatten(turn.attributes);
  assert.equal(Number(attributes["kiro.tool.call.count"]), 1);
  // Unknown is not zero, so the count and the usage are left off rather than guessed.
  for (const key of ["kiro.llm.request.count", "kiro.usage.credits", "gen_ai.usage.input_tokens"]) {
    assert.equal(key in attributes, false, key);
  }
  const tool = spans.find(
    (span) => flatten(span.attributes)["gen_ai.operation.name"] === "execute_tool",
  );
  assert.equal(tool?.traceId, turn.traceId);
  assert.equal(tool?.parentSpanId, turn.spanId);
});

test("a session resumed without state of its own does not replay its history", async () => {
  const sessionId = "kiro-session-3";
  const captured = await collector();
  const workdir = mkdtempSync(join(tmpdir(), "kiro-otel-hook-"));
  const box = sandbox(captured.port, workdir);
  const store = join(box.sessions, `${sessionId}.json`);

  try {
    const endIso = new Date().toISOString();
    // Three turns already finished before this hook ever saw the session, and stop is the
    // first event it gets — only the turn that just ended is its to report.
    writeFileSync(
      store,
      sessionStore(
        sessionId,
        [1, 2, 3].map(() =>
          turnMetadata({ requests: 1, tools: 0, credits: [0.02], endIso, durationSec: 5 }),
        ),
      ),
      "utf8",
    );
    await run({ hook_event_name: "stop", session_id: sessionId, cwd: "/repo" });
  } finally {
    box.restore();
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => captured.server.close(() => resolve()));
  }

  const { spans } = harvest(captured.envelopes);
  const turns = spans.filter(
    (span) => flatten(span.attributes)["gen_ai.operation.name"] === "invoke_agent",
  );
  assert.equal(turns.length, 1);
  const attributes = flatten(turns[0]?.attributes ?? []);
  assert.equal(Number(attributes["kiro.llm.request.count"]), 1);
  assert.equal(Number(attributes["kiro.usage.credits"]).toFixed(2), "0.02");
  // With neither tokens nor a credit rate there is no cost to determine, and the draft
  // forbids reporting one anyway.
  const chat = flatten(
    spans.find((span) => flatten(span.attributes)["gen_ai.operation.name"] === "chat")
      ?.attributes ?? [],
  );
  assert.equal("gen_ai.usage.cost.amount" in chat, false);
  assert.equal(Number(chat["kiro.usage.cost"]), 0);
});
