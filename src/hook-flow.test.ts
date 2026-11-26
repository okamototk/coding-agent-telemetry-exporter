import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { processPayload } from "./otel-genai-hook.ts";
import type { AgentRuntime } from "./core/types.ts";

interface Span {
  name: string;
  spanId: string;
  attributes: { key: string; value: Record<string, unknown> }[];
}

function attributesOf(span: Span): Record<string, unknown> {
  return Object.fromEntries(
    span.attributes.map((attribute) => [attribute.key, Object.values(attribute.value)[0]]),
  );
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Runs `body` against a local OTLP receiver with a fresh state dir and returns the names and
 * IDs of every span the hook sent.
 */
async function capture(body: (workdir: string) => Promise<void>): Promise<Span[]> {
  const spans: Span[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        resourceSpans?: { scopeSpans: { spans: Span[] }[] }[];
      };
      for (const resource of envelope.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans) {
          spans.push(...scope.spans);
        }
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const workdir = mkdtempSync(join(tmpdir(), "otel-session-start-"));
  const previous = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("CAT_OTEL_")) {
        delete process.env[name];
      }
    }
    process.env["CAT_OTEL_ENDPOINT"] = `http://127.0.0.1:${address.port}`;
    process.env["CAT_OTEL_STATE_DIR"] = join(workdir, "state");
    process.env["CAT_OTEL_METRICS"] = "0";
    await body(workdir);
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
  return spans;
}

function chats(spans: Span[]): Span[] {
  return spans.filter((span) => span.name.startsWith("chat"));
}

function claudeAssistant(
  id: string,
  promptId: string,
  timestamp: string,
  speed?: string,
): string {
  return line({
    type: "assistant",
    uuid: `${id}-text`,
    sessionId: "s-claude",
    promptId,
    timestamp,
    message: {
      id,
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 2, ...(speed ? { speed } : {}) },
    },
  });
}

for (const source of ["compact", "resume"] as const) {
  test(`Claude SessionStart(${source}) on the same transcript does not re-emit earlier requests`, async () => {
    const spans = await capture(async (workdir) => {
      const transcript = join(workdir, "s-claude.jsonl");
      const base = { session_id: "s-claude", cwd: "/repo", transcript_path: transcript };
      const run = (payload: Record<string, unknown>) =>
        processPayload({ ...base, ...payload }, "claude" satisfies AgentRuntime);
      writeFileSync(transcript, claudeAssistant("msg-1", "p1", "2026-11-26T00:00:01.000Z"), "utf8");
      await run({ hook_event_name: "SessionStart", source: "startup" });
      await run({ hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "one" });
      await run({ hook_event_name: "Stop", prompt_id: "p1" });

      // Claude Code keeps appending to the same file after /compact and --resume.
      await run({ hook_event_name: "SessionStart", source });
      appendFileSync(transcript, claudeAssistant("msg-2", "p2", "2026-11-26T00:00:02.000Z"));
      await run({ hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: "two" });
      await run({ hook_event_name: "Stop", prompt_id: "p2" });
    });
    assert.equal(chats(spans).length, 2, JSON.stringify(spans.map((span) => span.name)));
  });
}

function codexTokenCount(timestamp: string, last: number, total: number): string {
  const usage = (input: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    total_tokens: input + 1,
  });
  return line({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(total), last_token_usage: usage(last) },
    },
  });
}

function codexTurn(turnId: string, timestamp: string): string {
  return line({
    timestamp,
    type: "turn_context",
    payload: { turn_id: turnId, model: "gpt-6.2-sol", effort: "medium" },
  });
}

test("Codex SessionStart(resume) on the same rollout does not re-emit earlier requests", async () => {
  const spans = await capture(async (workdir) => {
    const rollout = join(workdir, "rollout.jsonl");
    const base = { session_id: "s-codex", cwd: "/repo", transcript_path: rollout };
    const run = (payload: Record<string, unknown>) =>
      processPayload({ ...base, ...payload }, "codex" satisfies AgentRuntime);
    // Two requests, so a re-read of the first (total 100, below the saved cumulative 130)
    // would look like a reset of the counters and be billed again in full.
    writeFileSync(
      rollout,
      codexTurn("t1", "2026-11-26T00:00:00.500Z") +
        codexTokenCount("2026-11-26T00:00:01.000Z", 100, 100) +
        codexTokenCount("2026-11-26T00:00:01.200Z", 30, 130),
      "utf8",
    );
    await run({ hook_event_name: "SessionStart", source: "startup" });
    await run({ hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "one" });
    await run({ hook_event_name: "Stop", turn_id: "t1" });

    // A resumed Codex session appends to the rollout it was recorded in.
    await run({ hook_event_name: "SessionStart", source: "resume" });
    appendFileSync(
      rollout,
      codexTurn("t2", "2026-11-26T00:00:01.500Z") +
        codexTokenCount("2026-11-26T00:00:02.000Z", 50, 180),
    );
    await run({ hook_event_name: "UserPromptSubmit", turn_id: "t2", prompt: "two" });
    await run({ hook_event_name: "Stop", turn_id: "t2" });
  });
  assert.equal(chats(spans).length, 3, JSON.stringify(spans.map((span) => span.name)));
});

test("SessionStart with a different transcript starts reading it from the beginning", async () => {
  const spans = await capture(async (workdir) => {
    const first = join(workdir, "first.jsonl");
    const second = join(workdir, "second.jsonl");
    const run = (payload: Record<string, unknown>) =>
      processPayload({ session_id: "s-switch", cwd: "/repo", ...payload }, "codex");
    writeFileSync(
      first,
      codexTurn("t1", "2026-11-26T00:00:00.500Z") +
        codexTokenCount("2026-11-26T00:00:01.000Z", 100, 100),
      "utf8",
    );
    await run({ hook_event_name: "SessionStart", source: "startup", transcript_path: first });
    await run({ hook_event_name: "Stop", turn_id: "t1", transcript_path: first });

    writeFileSync(
      second,
      codexTurn("t2", "2026-11-26T00:00:01.500Z") +
        codexTokenCount("2026-11-26T00:00:02.000Z", 40, 40),
      "utf8",
    );
    await run({ hook_event_name: "SessionStart", source: "resume", transcript_path: second });
    await run({ hook_event_name: "Stop", turn_id: "t2", transcript_path: second });
  });
  assert.equal(chats(spans).length, 2, JSON.stringify(spans.map((span) => span.name)));
});

test("Claude usage.speed \"fast\" is priced at the fast tier and reported on the chat span", async () => {
  const spans = await capture(async (workdir) => {
    const transcript = join(workdir, "s-fast.jsonl");
    writeFileSync(
      transcript,
      claudeAssistant("msg-std", "p1", "2026-11-26T00:00:01.000Z", "standard") +
        claudeAssistant("msg-fast", "p1", "2026-11-26T00:00:02.000Z", "fast"),
      "utf8",
    );
    const base = { session_id: "s-fast", cwd: "/repo", transcript_path: transcript };
    await processPayload({ ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, "claude");
    await processPayload({ ...base, hook_event_name: "Stop", prompt_id: "p1" }, "claude");
  });
  const bySpeed = new Map(
    chats(spans).map((span) => {
      const attributes = attributesOf(span);
      return [attributes["claude.request.speed"], attributes] as const;
    }),
  );
  const standard = bySpeed.get("standard");
  const fast = bySpeed.get("fast");
  assert.ok(standard && fast, JSON.stringify([...bySpeed.keys()]));
  // claude-opus-5-5: $4 / $20 standard, $8 / $40 fast; 10 input and 2 output tokens.
  assert.ok(Math.abs(Number(standard["claude.usage.cost"]) - (10 * 4 + 2 * 20) / 1e6) < 1e-12);
  assert.ok(Math.abs(Number(fast["claude.usage.cost"]) - (10 * 8 + 2 * 40) / 1e6) < 1e-12);
  assert.equal(fast["claude.usage.cost.pricing_matched"], true);
});
