/** Unit tests for deterministic ID derivation, and for the span key that replaces a counter. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drainClaudeTranscript } from "./claude-transcript.ts";
import { llmSpanId, toolSpanId, traceId, turnSpanId } from "./ids.ts";
import { emptyUsage, type HookState } from "./types.ts";

const SESSION = "01a02467-38a1-7ad2-9bc5-32037b0e52aa";
const TURN = "01a02467-3f01-7c50-8fbe-cfc45eb2d56d";

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** A minimal state, enough for drainClaudeTranscript's cursor bookkeeping. */
function state(): HookState {
  return {
    runtime: "claude",
    session_id: SESSION,
    started_at_ns: "0",
    rollout_path: null,
    rollout_offset: 0,
    llm_seq: 0,
    cumulative: emptyUsage(),
    session_totals: emptyUsage(),
    session_cost: 0,
    request_count: 0,
    turns: {},
    last_turn_id: null,
    last_event_ns: null,
    rollout_context: {},
    transcript_cursors: {},
    pending_turns: {},
    turn_seq: 0,
    turn_metadata_offset: 0,
    store_synced: false,
    open_tools: [],
    turn_tools: {},
  };
}

/** One assistant line of a Claude transcript, carrying its message id and usage. */
function assistantLine(messageId: string, text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: `uuid-${messageId}`,
    sessionId: SESSION,
    promptId: TURN,
    timestamp: "2026-08-25T01:00:01.000Z",
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  })}\n`;
}

function drain(lines: readonly string[]): ReturnType<typeof drainClaudeTranscript> {
  const workdir = mkdtempSync(join(tmpdir(), "ids-test-"));
  try {
    const path = join(workdir, "transcript.jsonl");
    writeFileSync(path, lines.join(""));
    return drainClaudeTranscript(path, state(), false, TURN);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("IDs are the right width and lowercase hex", () => {
  assert.match(traceId(SESSION, TURN, "claude"), TRACE_ID);
  assert.match(turnSpanId(SESSION, TURN, "claude"), SPAN_ID);
  assert.match(llmSpanId(SESSION, "msg:abc", "claude"), SPAN_ID);
  assert.match(toolSpanId(SESSION, "tool-1", "claude"), SPAN_ID);
});

test("the same inputs always yield the same ID, across processes", () => {
  // This is what keeps one turn in one trace: each hook event runs in its own process and
  // recomputes the IDs rather than sharing them.
  assert.equal(traceId(SESSION, TURN, "claude"), traceId(SESSION, TURN, "claude"));
  assert.equal(llmSpanId(SESSION, "msg:abc", "claude"), llmSpanId(SESSION, "msg:abc", "claude"));
});

test("different inputs yield different IDs", () => {
  const ids = new Set([
    traceId(SESSION, TURN, "claude"),
    traceId(SESSION, "other-turn", "claude"),
    traceId("other-session", TURN, "claude"),
    // The runtime namespaces the hash, so two agents cannot collide on one session id.
    traceId(SESSION, TURN, "codex"),
  ]);
  assert.equal(ids.size, 4);
});

test("a span ID is never all zeroes", () => {
  // An all-zero ID is invalid in OTLP; the guard replaces it. Exercised directly, since no
  // known input actually hashes to zero.
  for (const id of [turnSpanId(SESSION, TURN), llmSpanId(SESSION, 0), toolSpanId(SESSION, "x")]) {
    assert.notEqual(id, "0".repeat(id.length));
  }
});

test("a counter and a content key derive different IDs, so the schemes cannot meet", () => {
  // The counter path is only a fallback. If the two shared a namespace, request #12345 and
  // rollout offset 12345 would collide.
  assert.notEqual(llmSpanId(SESSION, 12_345), llmSpanId(SESSION, "off:12345"));
});

test("a Claude request carries the provider's message id as its span key", () => {
  const drained = drain([assistantLine("msg_A", "first"), assistantLine("msg_B", "second")]);
  assert.deepEqual(
    drained.requests.map((request) => request.spanKey),
    ["msg:msg_A", "msg:msg_B"],
  );
});

test("lines of one API response share a span key, so the request is not double counted", () => {
  // A single response is split across a line per content block, each repeating message.id.
  const drained = drain([assistantLine("msg_A", "thinking"), assistantLine("msg_A", "answer")]);
  assert.equal(drained.requests.length, 1);
  assert.equal(drained.requests[0]?.spanKey, "msg:msg_A");
});

test("concurrent hook processes cannot collide on a span ID", () => {
  // The regression this guards. Two hook processes run at once (a Stop overlapping a
  // SubagentStop, or parallel subagents); each loads the state file before the other saves,
  // so both see llm_seq = 0 and both allocate seq 1. Under the old counter scheme they
  // emitted two different chat spans under one span ID, which breaks the trace.
  const main = drain([assistantLine("msg_main", "main")]);
  const subagent = drain([assistantLine("msg_sub", "sub")]);

  const counterIds = [llmSpanId(SESSION, 1, "claude"), llmSpanId(SESSION, 1, "claude")];
  assert.equal(new Set(counterIds).size, 1, "a shared counter collides");

  const keyed = [main, subagent].map((drained) => {
    const key = drained.requests[0]?.spanKey;
    assert.ok(key);
    return llmSpanId(SESSION, key, "claude");
  });
  assert.equal(new Set(keyed).size, 2, "content-derived keys do not collide");
});

test("re-deriving a span ID for the same request is idempotent", () => {
  // Late-arriving usage for a request already reported must land on the same span, not a
  // second one, however many events have gone by since.
  const first = drain([assistantLine("msg_A", "text")]).requests[0]?.spanKey;
  const again = drain([assistantLine("msg_A", "text")]).requests[0]?.spanKey;
  assert.ok(first);
  assert.equal(first, again);
  assert.equal(llmSpanId(SESSION, first, "claude"), llmSpanId(SESSION, again ?? "", "claude"));
});
