/**
 * Reads the Kiro CLI session store.
 *
 * A Kiro hook payload carries no usage at all — `stop` delivers only `hook_event_name`,
 * `cwd`, `session_id`, and `assistant_response` — so usage comes from the session state Kiro
 * CLI writes itself, `~/.kiro/sessions/cli/<session_id>.json`. One
 * `conversation_metadata.user_turn_metadatas` entry summarizes one finished turn:
 *
 *     {"session_state": {"conversation_metadata": {"user_turn_metadatas": [{
 *         "total_request_count": 2, "builtin_tool_uses": 1,
 *         "turn_duration": {"secs": 21, "nanos": 556844231},
 *         "end_timestamp": "2026-09-17T10:56:44.857017050Z",
 *         "input_token_count": 0, "output_token_count": 0, "model": "auto",
 *         "metering_usage": [{"value": 0.048, "unit": "credit"}, {"value": 0.023, ...}]}]}}}
 *
 * Two properties of that record shape the whole Kiro path:
 *
 * - **Usage is per turn, not per request.** There is one entry per turn, however many LLM
 *   requests it made, so a per-request figure has to be apportioned (see kiro.ts).
 * - **The unit is credits.** `*_token_count` is 0 for a Kiro service account, which meters
 *   plan credits instead, one `metering_usage` entry per request. Credits are neither tokens
 *   nor money, so they are reported as they are and converted only when the operator supplies
 *   a rate (see creditCost in pricing.ts).
 *
 * The array only grows, so progress is a count of consumed entries rather than a byte offset.
 * Unlike the Codex rollout there is no partial-line problem: the file is rewritten whole, so
 * a read either sees the previous state or the next one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { kiroSessionsDir } from "./env.ts";
import { isoToNs } from "./time.ts";
import { emptyUsage, type RolloutContext, type Usage } from "./types.ts";

/** One finished turn, as the session store reports it. */
export interface KiroTurnMetadata {
  /** LLM requests the turn made (`total_request_count`). */
  requests: number;
  /** Tool calls the turn made, or null when the store did not report any count. */
  toolCalls: number | null;
  /** Requests actually sent, retries included; always >= requests. */
  attempts: number;
  usage: Usage;
  /** Whether any token count was reported. False for a credit-metered account. */
  tokensReported: boolean;
  /** The `metering_usage` amounts in credits, one per request, in request order. */
  credits: number[];
  model: string | null;
  startNs: bigint | null;
  endNs: bigint | null;
  /** How much of the context window the conversation filled, as a percentage. */
  contextPercent: number | null;
  endReason: string | null;
  /** The turn's failure, from a `result: {"Err": ...}`. */
  error: string | null;
}

export interface KiroDrain {
  turns: KiroTurnMetadata[];
  /** How many `user_turn_metadatas` entries have now been consumed. */
  offset: number;
  context: RolloutContext;
}

export function kiroSessionPath(sessionId: string): string {
  return join(kiroSessionsDir(), `${sessionId}.json`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asInt(value: unknown): number {
  const parsed = asNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

/**
 * The canonical usage form. Kiro reports the input side already split, so the parts are added
 * up the way the Claude transcript is: `input_tokens` is the whole prompt, cache reads and
 * writes included.
 */
function usageOfTurn(turn: Record<string, unknown>): { usage: Usage; reported: boolean } {
  const input = asInt(turn["input_token_count"]);
  const output = asInt(turn["output_token_count"]);
  const cacheRead = asInt(turn["cache_read_input_token_count"]);
  const cacheWrite = asInt(turn["cache_write_input_token_count"]);
  const usage: Usage = {
    ...emptyUsage(),
    input_tokens: input + cacheRead + cacheWrite,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: input + cacheRead + cacheWrite + output,
  };
  return { usage, reported: usage.total_tokens > 0 };
}

/** The `metering_usage` amounts, keeping only the entries denominated in credits. */
function creditsOf(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const credits: number[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const value = entry ? asNumber(entry["value"]) : null;
    const unit = entry ? (asString(entry["unit"]) ?? "").toLowerCase() : "";
    if (value !== null && value > 0 && (unit === "credit" || unit === "credits")) {
      credits.push(value);
    }
  }
  return credits;
}

/** end_timestamp is when the turn finished; turn_duration walks back to its start. */
function boundsOf(turn: Record<string, unknown>): { startNs: bigint | null; endNs: bigint | null } {
  const endNs = isoToNs(turn["end_timestamp"]);
  const duration = asRecord(turn["turn_duration"]);
  if (endNs === null || duration === null) {
    return { startNs: null, endNs };
  }
  const elapsed = BigInt(asInt(duration["secs"])) * 1_000_000_000n + BigInt(asInt(duration["nanos"]));
  return { startNs: endNs - elapsed, endNs };
}

/** `result` is an internally tagged enum: `{"Ok": ...}` on success, `{"Err": ...}` on failure. */
function errorOf(turn: Record<string, unknown>): string | null {
  const result = asRecord(turn["result"]);
  if (result === null || !("Err" in result)) {
    return null;
  }
  const failure = result["Err"];
  const text = typeof failure === "string" ? failure : JSON.stringify(failure);
  return (text || "turn failed").slice(0, 500);
}

function turnOf(raw: unknown): KiroTurnMetadata | null {
  const turn = asRecord(raw);
  if (turn === null) {
    return null;
  }
  const { usage, reported } = usageOfTurn(turn);
  const { startNs, endNs } = boundsOf(turn);
  const builtin = asNumber(turn["builtin_tool_uses"]);
  const mcp = asNumber(turn["mcp_tool_uses"]);
  return {
    requests: asInt(turn["total_request_count"]),
    toolCalls: builtin === null && mcp === null ? null : asInt(builtin) + asInt(mcp),
    attempts: asInt(turn["request_attempts"]),
    usage,
    tokensReported: reported,
    credits: creditsOf(turn["metering_usage"]),
    model: asString(turn["model"]),
    startNs,
    endNs,
    contextPercent:
      asNumber(turn["final_context_usage_percentage"]) ?? asNumber(turn["context_usage_percentage"]),
    endReason: asString(turn["end_reason"]),
    error: errorOf(turn),
  };
}

/** Session-wide context: the agent that runs the session, its model, and the context window. */
function contextOf(session: Record<string, unknown>): RolloutContext {
  const context: RolloutContext = {};
  const state = asRecord(session["session_state"]);
  context.session_started_ns = isoToNs(session["created_at"])?.toString() ?? null;
  if (state === null) {
    return context;
  }
  context.agent_name = asString(state["agent_name"]);
  const model = asRecord(asRecord(state["rts_model_state"])?.["model_info"]);
  if (model !== null) {
    context.model = asString(model["model_id"]);
    context.context_window = asNumber(model["context_window_tokens"]);
  }
  return context;
}

function parse(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The session-wide context alone. Kiro writes it when the session starts, so it is readable
 * from the very first event — unlike the turn metadata, which lands only after a turn ends.
 */
export function kiroSessionContext(path: string): RolloutContext {
  const session = parse(path);
  return session === null ? {} : contextOf(session);
}

/** Reads the store and returns the turns past `offset`, plus the new consumed count. */
export function drainKiroSession(path: string, offset: number): KiroDrain {
  const turns: KiroTurnMetadata[] = [];
  const session = parse(path);
  if (session === null) {
    return { turns, offset, context: {} };
  }

  const metadata = asRecord(
    asRecord(asRecord(session["session_state"])?.["conversation_metadata"]),
  );
  const entries = metadata === null ? null : metadata["user_turn_metadatas"];
  const list = Array.isArray(entries) ? entries : [];
  // A session that was cleared or replaced starts the array over, so a shrunken array resets
  // the count rather than skipping the turns that follow.
  const start = offset > list.length ? 0 : offset;
  for (const item of list.slice(start)) {
    const turn = turnOf(item);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  return { turns, offset: list.length, context: contextOf(session) };
}
