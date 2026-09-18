/** State — the hook is a separate process per event, so progress is kept on disk. */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { debug, stateDir } from "./env.ts";
import { nowNs } from "./time.ts";
import {
  emptyUsage,
  type AgentRuntime,
  type HookState,
  type RolloutContext,
  type SerializedTurnBucket,
  type ToolWindow,
  type TranscriptCursor,
  type TurnState,
  type Usage,
  USAGE_KEYS,
} from "./types.ts";

function statePath(sessionId: string, runtime: AgentRuntime): string {
  const safe = [...sessionId]
    .map((ch) => (/[a-zA-Z0-9\-_]/.test(ch) ? ch : "_"))
    .join("")
    .slice(0, 128);
  return join(stateDir(runtime), "sessions", `${safe}.json`);
}

function toInt(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toFloat(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

/** Normalizes usage from the state file, coercing missing keys and bad types to 0. */
export function usageOf(raw: unknown): Usage {
  const out = emptyUsage();
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of USAGE_KEYS) {
      out[key] = toInt(record[key]);
    }
  }
  return out;
}

function turnsOf(raw: unknown): Record<string, TurnState> {
  const out: Record<string, TurnState> = {};
  if (raw && typeof raw === "object") {
    for (const [turnId, value] of Object.entries(raw as Record<string, unknown>)) {
      out[turnId] = value && typeof value === "object" ? (value as TurnState) : {};
    }
  }
  return out;
}

function freshState(sessionId: string, runtime: AgentRuntime): HookState {
  return {
    runtime,
    session_id: sessionId,
    started_at_ns: nowNs().toString(),
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

function cursorsOf(raw: unknown): Record<string, TranscriptCursor> {
  return raw && typeof raw === "object" ? (raw as Record<string, TranscriptCursor>) : {};
}

function pendingTurnsOf(raw: unknown): Record<string, SerializedTurnBucket> {
  return raw && typeof raw === "object" ? (raw as Record<string, SerializedTurnBucket>) : {};
}

function toolWindowsOf(raw: unknown): Record<string, ToolWindow[]> {
  const out: Record<string, ToolWindow[]> = {};
  if (raw && typeof raw === "object") {
    for (const [turnId, value] of Object.entries(raw as Record<string, unknown>)) {
      out[turnId] = Array.isArray(value) ? (value as ToolWindow[]) : [];
    }
  }
  return out;
}

export function loadState(sessionId: string, runtime: AgentRuntime = "codex"): HookState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath(sessionId, runtime), "utf8"));
  } catch {
    return freshState(sessionId, runtime);
  }
  if (!raw || typeof raw !== "object") {
    return freshState(sessionId, runtime);
  }
  const saved = raw as Partial<HookState> & Record<string, unknown>;
  const base = freshState(sessionId, runtime);
  return {
    ...base,
    ...saved,
    runtime,
    session_id: sessionId,
    // Stay readable for older state formats (ns as number, usage missing).
    started_at_ns: String(saved.started_at_ns ?? base.started_at_ns),
    rollout_path: typeof saved.rollout_path === "string" ? saved.rollout_path : null,
    rollout_offset: toInt(saved.rollout_offset),
    llm_seq: toInt(saved.llm_seq),
    cumulative: usageOf(saved.cumulative),
    session_totals: usageOf(saved.session_totals),
    session_cost: toFloat(saved.session_cost),
    request_count: toInt(saved.request_count),
    turns: turnsOf(saved.turns),
    rollout_context: (saved.rollout_context as RolloutContext | undefined) ?? {},
    transcript_cursors: cursorsOf(saved.transcript_cursors),
    pending_turns: pendingTurnsOf(saved.pending_turns),
    turn_seq: toInt(saved.turn_seq),
    turn_metadata_offset: toInt(saved.turn_metadata_offset),
    store_synced: saved.store_synced === true,
    open_tools: Array.isArray(saved.open_tools) ? saved.open_tools : [],
    turn_tools: toolWindowsOf(saved.turn_tools),
  };
}

export function saveState(state: HookState): void {
  const path = statePath(state.session_id, state.runtime);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), "utf8");
  renameSync(temporary, path);
}

/**
 * How long to wait for another process to finish its read-modify-write. Deliberately short:
 * the hook sits on the agent's critical path, and the section being guarded is a small file
 * read, some arithmetic, and a rename.
 */
const LOCK_WAIT_MS = 50;

/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 5_000;

/** Backs `sleepMs`. Atomics.wait is the only way to sleep without going async. */
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}

/** Removes a lock whose holder is gone, so one crashed process cannot block the rest. */
function breakIfStale(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already gone, or not ours to remove; either way the next attempt decides.
  }
}

/**
 * Takes the lock for one session's state file, or returns null if it could not be had.
 *
 * `wx` fails when the file exists, which makes creating it the atomic test-and-set.
 */
function acquire(lockPath: string): number | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return openSync(lockPath, "wx");
    } catch {
      // Held by another process.
    }
    breakIfStale(lockPath);
    if (Date.now() >= deadline) {
      return null;
    }
    sleepMs(5);
  }
}

function release(lockPath: string, handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // Nothing further to do; the unlink below is what actually frees the lock.
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Someone judged it stale and removed it already.
  }
}

/**
 * Loads the session's state, hands it to `work`, and saves whatever `work` left behind — with
 * the whole read-modify-write serialized against other hook processes.
 *
 * The rename in {@link saveState} makes each write atomic, so a reader never sees half a
 * file, but it does nothing about *lost updates*: two processes that both load before either
 * saves, and the second write discards the first process's work. That is a live case rather
 * than a theoretical one, because Claude Code runs subagents in parallel — a `Stop`
 * overlapping a `SubagentStop`, or two subagents finishing together — and what gets lost is
 * one of them entirely: its `pending_turns` bucket, so its tokens and cost never reach a span.
 *
 * Failing to take the lock is not an error. The hook must never halt a session, so after
 * {@link LOCK_WAIT_MS} it proceeds unlocked: the outcome is then what it was before this
 * existed, which is better than making the agent wait.
 *
 * `work` must stay synchronous. An `await` inside it would let another event of this process
 * interleave within the section this is meant to keep to itself.
 */
export function withState<T>(
  sessionId: string,
  runtime: AgentRuntime,
  work: (state: HookState) => T,
): T {
  const path = statePath(sessionId, runtime);
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const handle = acquire(lockPath);
  if (handle === null) {
    debug(`state lock busy after ${LOCK_WAIT_MS}ms, proceeding unlocked session=${sessionId}`, runtime);
  }
  try {
    const state = loadState(sessionId, runtime);
    // Saved only on success: a handler that threw leaves state as it found it, and the
    // caller's fail-open catch reports it.
    const result = work(state);
    saveState(state);
    return result;
  } finally {
    if (handle !== null) {
      release(lockPath, handle);
    }
  }
}
