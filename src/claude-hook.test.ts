import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { processPayload } from "./otel-genai-hook.ts";

interface Attribute {
  key: string;
  value: Record<string, unknown>;
}

interface CapturedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Attribute[];
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

function flatten(attributes: Attribute[]): Record<string, string | number | boolean> {
  return Object.fromEntries(
    attributes.map((attribute) => [
      attribute.key,
      Object.values(attribute.value)[0] as string | number | boolean,
    ]),
  );
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const sessionId = "claude-session-1";
const promptId = "claude-prompt-1";
const model = "claude-sonnet-4-5";

function assistant(
  id: string,
  timestamp: string,
  content: Record<string, unknown>,
  usage: Record<string, unknown>,
  agentId?: string,
): string {
  return line({
    type: "assistant",
    uuid: `${id}-${String(content["type"])}`,
    sessionId,
    promptId,
    agentId,
    timestamp,
    effort: "high",
    message: {
      id,
      role: "assistant",
      model,
      content: [content],
      usage,
    },
  });
}

test("folds the Claude transcript, cache usage, tools, and subagents into one turn trace", async () => {
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

  const workdir = mkdtempSync(join(tmpdir(), "claude-otel-hook-"));
  const main = join(workdir, `${sessionId}.jsonl`);
  const subagent = join(workdir, "agent-sub1.jsonl");
  const firstUsage = {
    input_tokens: 100,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 30,
    cache_creation: {
      ephemeral_5m_input_tokens: 20,
      ephemeral_1h_input_tokens: 10,
    },
    output_tokens: 10,
    output_tokens_details: { thinking_tokens: 4 },
  };
  writeFileSync(
    main,
    [
      line({
        type: "user",
        uuid: "user-1",
        sessionId,
        promptId,
        timestamp: "2026-08-25T01:00:00.000Z",
        message: { role: "user", content: "調査して" },
      }),
      // The same API message is split across a thinking line and a tool_use line, and the
      // usage is repeated on both.
      assistant(
        "msg-1",
        "2026-08-25T01:00:01.000Z",
        { type: "thinking", thinking: "確認する" },
        firstUsage,
      ),
      assistant(
        "msg-1",
        "2026-08-25T01:00:01.100Z",
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "printf ok" } },
        firstUsage,
      ),
      line({
        type: "user",
        uuid: "tool-result-1",
        sessionId,
        promptId,
        timestamp: "2026-08-25T01:00:01.300Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        },
      }),
      assistant(
        "msg-2",
        "2026-08-25T01:00:02.000Z",
        { type: "text", text: "完了" },
        {
          input_tokens: 40,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 0,
          output_tokens: 5,
          output_tokens_details: { thinking_tokens: 0 },
        },
      ),
    ].join(""),
    "utf8",
  );
  writeFileSync(
    subagent,
    [
      line({
        type: "user",
        uuid: "sub-user",
        sessionId,
        promptId,
        agentId: "sub1",
        timestamp: "2026-08-25T01:00:01.400Z",
        message: { role: "user", content: "詳細を確認" },
      }),
      assistant(
        "sub-msg-1",
        "2026-08-25T01:00:01.800Z",
        { type: "text", text: "詳細" },
        {
          input_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 3,
          output_tokens_details: { thinking_tokens: 0 },
        },
        "sub1",
      ),
    ].join(""),
    "utf8",
  );

  const previous = { ...process.env };
  try {
    process.env["CAT_OTEL_ENDPOINT"] = `http://127.0.0.1:${address.port}`;
    process.env["CAT_OTEL_STATE_DIR"] = join(workdir, "state");
    process.env["CAT_OTEL_CAPTURE_PROMPTS"] = "1";
    process.env["CAT_OTEL_SERVICE_NAME"] = "claude-test";

    const base = { session_id: sessionId, cwd: "/repo", transcript_path: main };
    await processPayload(
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      "claude",
    );
    await processPayload(
      {
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt_id: promptId,
        prompt: "調査して",
      },
      "claude",
    );
    await processPayload(
      {
        ...base,
        hook_event_name: "SubagentStop",
        prompt_id: promptId,
        agent_id: "sub1",
        agent_type: "general-purpose",
        agent_transcript_path: subagent,
      },
      "claude",
    );
    await processPayload(
      {
        ...base,
        hook_event_name: "Stop",
        prompt_id: promptId,
        last_assistant_message: "完了",
      },
      "claude",
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
    rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const spans: CapturedSpan[] = [];
  const metrics: CapturedMetric[] = [];
  let resource: Record<string, string | number | boolean> | null = null;
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

  // gen_ai.operation.name alone identifies the kind of span; there is no custom one.
  const byKind = (operation: string): CapturedSpan[] =>
    spans.filter((span) => flatten(span.attributes)["gen_ai.operation.name"] === operation);
  assert.equal(byKind("chat").length, 3);
  assert.equal(byKind("execute_tool").length, 1);
  assert.equal(byKind("invoke_agent").length, 1);

  const turn = byKind("invoke_agent")[0];
  assert.ok(turn);
  const turnAttrs = flatten(turn.attributes);
  // Per semconv, the span name is `invoke_agent {gen_ai.agent.name}`.
  assert.equal(turn.name, "invoke_agent claude-code");
  assert.equal(turnAttrs["gen_ai.provider.name"], "anthropic");
  assert.equal(turnAttrs["gen_ai.agent.name"], "claude-code");
  assert.equal(Number(turnAttrs["claude.llm.request.count"]), 3);
  assert.equal(Number(turnAttrs["claude.tool.call.count"]), 1);
  assert.equal(Number(turnAttrs["gen_ai.usage.input_tokens"]), 250);
  assert.equal(Number(turnAttrs["gen_ai.usage.output_tokens"]), 18);
  assert.equal(Number(turnAttrs["gen_ai.usage.reasoning.output_tokens"]), 4);
  assert.equal(Number(turnAttrs["claude.usage.total_tokens"]), 268);
  // semconv drops the cache breakdown from the invoke_agent span, since a sum across
  // several models and requests is misleading. The breakdown lives on the chat spans.
  assert.equal("gen_ai.usage.cache_read.input_tokens" in turnAttrs, false);
  assert.equal("gen_ai.usage.cache_write.input_tokens" in turnAttrs, false);
  assert.equal("claude.usage.uncached_input_tokens" in turnAttrs, false);
  // The agent switches models dynamically, so gen_ai.request.model is left off.
  assert.equal("gen_ai.request.model" in turnAttrs, false);
  assert.equal("gen_ai.response.model" in turnAttrs, false);

  // The cache breakdown for msg-1 (thinking + tool_use).
  const cached = byKind("chat")
    .map((span) => flatten(span.attributes))
    .find((item) => Number(item["gen_ai.usage.cache_read.input_tokens"]) === 50);
  assert.ok(cached);
  assert.equal(Number(cached["gen_ai.usage.input_tokens"]), 180);
  assert.equal(Number(cached["gen_ai.usage.cache_write.input_tokens"]), 30);
  assert.equal(Number(cached["claude.usage.cache_write.5m.input_tokens"]), 20);
  assert.equal(Number(cached["claude.usage.cache_write.1h.input_tokens"]), 10);
  assert.equal(Number(cached["gen_ai.usage.reasoning.output_tokens"]), 4);
  assert.equal(cached["gen_ai.request.model"], model);
  assert.equal(cached["gen_ai.agent.name"], "claude-code");

  // The subagent's spans. semconv treats a subagent as a distinct agent and defines
  // gen_ai.agent.name as the name of the agent that ran the tool or inference, so
  // agent_type goes there rather than into a custom attribute.
  const sub = byKind("chat")
    .map((span) => flatten(span.attributes))
    .find((item) => Number(item["gen_ai.usage.input_tokens"]) === 20);
  assert.ok(sub);
  assert.equal(sub["gen_ai.agent.name"], "general-purpose");
  // gen_ai.agent.id is for a stable, provider-issued ID; a transient in-process ID there
  // is NOT RECOMMENDED, so agent_id stays a custom attribute.
  assert.equal(sub["claude.agent.id"], "sub1");
  assert.equal("claude.agent.type" in sub, false);
  assert.equal("gen_ai.agent.id" in sub, false);
  for (const removed of [
    "agent.span.kind",
    "claude.span.kind",
    "agent.runtime",
    "claude.session.id",
  ]) {
    assert.equal(removed in turnAttrs, false, removed);
  }

  for (const child of [...byKind("chat"), ...byKind("execute_tool")]) {
    assert.equal(child.traceId, turn.traceId);
    assert.equal(child.parentSpanId, turn.spanId);
  }
  assert.equal(resource?.["service.name"], "claude-test");

  // The metrics come from the same observations. SubagentStop and Stop send separately, so
  // the delta data points are summed across deliveries.
  const totals = (
    name: string,
    match: Record<string, string | number | boolean> = {},
  ): { count: number; sum: number } => {
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
  };
  const input = totals("gen_ai.client.token.usage", {
    "gen_ai.token.type": "input",
    "gen_ai.provider.name": "anthropic",
  });
  assert.equal(input.count, 3);
  assert.equal(input.sum, 250);
  assert.equal(totals("gen_ai.client.token.usage", { "gen_ai.token.type": "output" }).sum, 18);
  assert.equal(totals("gen_ai.client.operation.duration").count, 3);
  const inference = totals("gen_ai.invoke_agent.inference_calls", {
    "gen_ai.agent.name": "claude-code",
  });
  assert.equal(inference.count, 1);
  assert.equal(inference.sum, 3);
  assert.equal(totals("gen_ai.invoke_agent.tool_calls").sum, 1);
  const tool = totals("gen_ai.execute_tool.duration", { "gen_ai.tool.name": "Bash" });
  assert.equal(tool.count, 1);
});
