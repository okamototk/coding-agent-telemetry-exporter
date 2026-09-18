/**
 * Tests for the state file's read-modify-write: that withState serializes it, and that a
 * lock it cannot take never blocks the turn.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadState, withState } from "./state.ts";
import type { HookState } from "./types.ts";

// src/*.test.ts exercises src/*.ts; dist/*.test.js exercises dist/*.js.
const HOOK = fileURLToPath(import.meta.url).replace(/state\.test\.(m?[jt]s)$/, "otel-genai-hook.$1");

const SESSION_ID = "01a02467-38a1-7ad2-9bc5-32037b0e52aa";
const PROMPT_ID = "01a02467-3f01-7c50-8fbe-cfc45eb2d56d";

/** Runs `body` with the state directory pointed at a fresh temp dir. */
function sandbox(body: (workdir: string) => void | Promise<void>): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), "state-test-"));
  const saved = process.env["CAT_OTEL_STATE_DIR"];
  process.env["CAT_OTEL_STATE_DIR"] = join(workdir, "state");
  return Promise.resolve(body(workdir)).finally(() => {
    if (saved === undefined) {
      delete process.env["CAT_OTEL_STATE_DIR"];
    } else {
      process.env["CAT_OTEL_STATE_DIR"] = saved;
    }
    rmSync(workdir, { recursive: true, force: true });
  });
}

function statePath(workdir: string): string {
  return join(workdir, "state", "sessions", `${SESSION_ID}.json`);
}

test("withState persists what the callback changed", async () => {
  await sandbox((workdir) => {
    const returned = withState(SESSION_ID, "claude", (state) => {
      state.request_count = 7;
      state.last_turn_id = PROMPT_ID;
      return "result";
    });
    assert.equal(returned, "result");

    const saved = loadState(SESSION_ID, "claude");
    assert.equal(saved.request_count, 7);
    assert.equal(saved.last_turn_id, PROMPT_ID);
    assert.ok(existsSync(statePath(workdir)));
  });
});

test("the lock is held during the callback and released afterwards", async () => {
  await sandbox((workdir) => {
    const lockPath = `${statePath(workdir)}.lock`;
    let heldDuringWork = false;
    withState(SESSION_ID, "claude", () => {
      heldDuringWork = existsSync(lockPath);
    });
    assert.equal(heldDuringWork, true, "the lock should exist while the callback runs");
    assert.equal(existsSync(lockPath), false, "the lock should be gone afterwards");
  });
});

test("a callback that throws leaves the state file alone and frees the lock", async () => {
  await sandbox((workdir) => {
    const lockPath = `${statePath(workdir)}.lock`;
    assert.throws(() => {
      withState(SESSION_ID, "claude", () => {
        throw new Error("handler failed");
      });
    }, /handler failed/);
    // Nothing was saved, and the lock did not leak -- the next event must not find it held.
    assert.equal(existsSync(statePath(workdir)), false);
    assert.equal(existsSync(lockPath), false);
  });
});

test("a lock held by someone else is waited on, then proceeds unlocked", async () => {
  await sandbox((workdir) => {
    const path = statePath(workdir);
    // Create the lock the way acquire() would, and keep holding it.
    withState(SESSION_ID, "claude", (state) => {
      state.request_count = 1;
    });
    const lockPath = `${path}.lock`;
    const held = openSync(lockPath, "wx");
    try {
      const started = Date.now();
      withState(SESSION_ID, "claude", (state) => {
        state.request_count = 2;
      });
      const waited = Date.now() - started;
      // It gave the holder a chance...
      assert.ok(waited >= 40, `waited ${waited}ms, expected to wait out the budget`);
      // ...but the turn is never blocked on a lock: the work still happened. The hook is
      // fail-open, so a stuck holder degrades to the old unlocked behaviour, not to a stall.
      assert.ok(waited < 2_000, `waited ${waited}ms, far longer than the budget`);
      assert.equal(loadState(SESSION_ID, "claude").request_count, 2);
      // Someone else's lock is left for them to release.
      assert.equal(existsSync(lockPath), true);
    } finally {
      closeSync(held);
      rmSync(lockPath, { force: true });
    }
  });
});

test("a stale lock is broken rather than waited on", async () => {
  await sandbox((workdir) => {
    const path = statePath(workdir);
    withState(SESSION_ID, "claude", (state) => {
      state.request_count = 1;
    });
    const lockPath = `${path}.lock`;
    closeSync(openSync(lockPath, "wx"));
    // Backdate it past the stale threshold: the holder died without releasing.
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    const started = Date.now();
    withState(SESSION_ID, "claude", (state) => {
      state.request_count = 2;
    });
    const waited = Date.now() - started;
    assert.ok(waited < 40, `waited ${waited}ms; a stale lock should be broken immediately`);
    assert.equal(loadState(SESSION_ID, "claude").request_count, 2);
    // Broken, taken, and then released normally.
    assert.equal(existsSync(lockPath), false);
  });
});

/** One assistant line of a subagent transcript, with the usage to be attributed. */
function subagentTranscript(messageId: string, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: `uuid-${messageId}`,
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    timestamp: "2026-08-25T01:00:01.000Z",
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

/** Runs the hook as its own process, the way an agent invokes it. */
function runHook(payload: unknown, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, "--runtime=claude"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`hook exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("two concurrent hook processes both reach the state file", async () => {
  // The failure this guards: two SubagentStop processes each load the state file before the
  // other saves, and the second save discards the first's pending_turns -- so one subagent's
  // tokens and cost never reach a span. Both subagents report into the same turn, so their
  // usage must add up.
  //
  // Whether the unlocked version loses the update on any given run depends on how the two
  // processes interleave, so this asserts the invariant rather than reproducing the race; the
  // lock's own behaviour is covered deterministically by the cases above.
  const workdir = mkdtempSync(join(tmpdir(), "state-concurrent-"));
  const collector = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    const first = join(workdir, "agent-first.jsonl");
    const second = join(workdir, "agent-second.jsonl");
    writeFileSync(first, subagentTranscript("msg_first", 100));
    writeFileSync(second, subagentTranscript("msg_second", 1_000));

    const env = {
      CAT_OTEL_STATE_DIR: join(workdir, "state"),
      CAT_OTEL_ENDPOINT: `http://127.0.0.1:${port}`,
      CAT_OTEL_TIMEOUT: "2",
    };
    const payload = (transcript: string, agent: string): unknown => ({
      hook_event_name: "SubagentStop",
      session_id: SESSION_ID,
      prompt_id: PROMPT_ID,
      agent_id: agent,
      agent_type: "general-purpose",
      agent_transcript_path: transcript,
      cwd: workdir,
      model: "claude-sonnet-4-5",
    });

    // Started together, so their read-modify-writes overlap.
    await Promise.all([
      runHook(payload(first, "sub-1"), env),
      runHook(payload(second, "sub-2"), env),
    ]);

    const saved = JSON.parse(
      readFileSync(join(workdir, "state", "sessions", `${SESSION_ID}.json`), "utf8"),
    ) as HookState;
    const pending = saved.pending_turns[PROMPT_ID];
    assert.ok(pending, `no pending turn stashed; got ${Object.keys(saved.pending_turns).join(",")}`);
    assert.equal(
      pending.usage.output_tokens,
      1_100,
      "both subagents' usage must survive; a lost update would leave only one",
    );
    assert.equal(pending.count, 2);
    // Each transcript is tracked separately, so neither cursor was dropped either.
    assert.equal(Object.keys(saved.transcript_cursors).length, 2);
  } finally {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    rmSync(workdir, { recursive: true, force: true });
  }
});
