/** State — the hook is a separate process per event, so progress is kept on disk. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "./env.ts";
import { nowNs } from "./time.ts";
import {
  emptyUsage,
  type AgentRuntime,
  type HookState,
  type RolloutContext,
  type SerializedTurnBucket,
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
  };
}

function cursorsOf(raw: unknown): Record<string, TranscriptCursor> {
  return raw && typeof raw === "object" ? (raw as Record<string, TranscriptCursor>) : {};
}

function pendingTurnsOf(raw: unknown): Record<string, SerializedTurnBucket> {
  return raw && typeof raw === "object" ? (raw as Record<string, SerializedTurnBucket>) : {};
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
  };
}

export function saveState(state: HookState): void {
  const path = statePath(state.session_id, state.runtime);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), "utf8");
  renameSync(temporary, path);
}
