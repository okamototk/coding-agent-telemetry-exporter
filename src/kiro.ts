/**
 * Kiro CLI hook handling: turning its five hook triggers plus its session store into spans.
 *
 * Kiro differs from Codex and Claude Code in what it hands the hook, so it gets its own
 * assembly rather than sharing theirs:
 *
 * - **No turn identifier.** Nothing in the payload ties events of one turn together, so the
 *   turn id is a counter of `userPromptSubmit` events (`t1`, `t2`, ...). It only has to be
 *   stable within the session, since the trace id is derived from it.
 * - **No usage in the payload, and none per request.** The session store summarizes a whole
 *   turn (see kiro-session.ts), so the per-request figures a `chat` span needs are
 *   apportioned across the turn's requests.
 * - **Tool calls come from hooks, not from a transcript.** `preToolUse` / `postToolUse`
 *   bracket each execution, which times it more precisely than any file would — and the
 *   brackets double as the boundaries that place the `chat` spans (below).
 *
 * Where the LLM requests sit inside the turn is reconstructed from those tool brackets. An
 * agent loop alternates request → tool batch → request, so with N batches the turn holds N+1
 * request windows:
 *
 *     turn start ──chat── tool tool ──chat── tool ──chat── turn end
 *                        └─ batch 1 ─┘      └batch 2┘
 *
 * Kiro's `total_request_count` matched `batches + 1` in every session measured, and its
 * `metering_usage` array holds exactly one credit amount per request, so the i-th amount is
 * paired with the i-th window.
 *
 * One more asymmetry decides the shape of the `stop` path: Kiro persists the session store
 * only **after** the `stop` hook it is waiting on has exited, so a `stop` hook can never read
 * its own turn. The event is therefore handed to a detached copy of the hook, which does the
 * waiting where Kiro is not waiting on it — see {@link deferKiroStop}.
 *
 * Anything the hook writes to stdout is injected into the model's context as additional
 * context, so this path prints nothing at all.
 */

import { spawn } from "node:child_process";

import { debug, flag, numberEnv } from "./env.ts";
import { llmSpanId, toolSpanId, traceId, turnSpanId } from "./ids.ts";
import {
  drainKiroSession,
  kiroSessionContext,
  kiroSessionPath,
  type KiroTurnMetadata,
} from "./kiro-session.ts";
import {
  ERROR_TYPE_OTHER,
  recordChat,
  recordTool,
  recordTurn,
  type MetricStore,
} from "./metrics.ts";
import { attrs, double, span, SPAN_KIND_CLIENT, type OtlpSpan } from "./otlp.ts";
import { cost, creditCost, type Pricing } from "./pricing.ts";
import { addUsage } from "./rollout.ts";
import { loadState } from "./state.ts";
import {
  agentName,
  commonAttrs,
  inferenceAttrs,
  placement,
  providerName,
  singleMessage,
  text,
  turnAttr,
  usageAttrs,
  type AttrPair,
} from "./spans.ts";
import { nowNs, toNs } from "./time.ts";
import {
  emptyUsage,
  mapUsage,
  USAGE_KEYS,
  type HookPayload,
  type HookState,
  type OpenToolState,
  type RolloutContext,
  type ToolWindow,
  type TurnState,
  type Usage,
  type UsageKey,
} from "./types.ts";

/** The hook triggers a Kiro agent config can declare, as `hook_event_name` reports them. */
export const KIRO_TRIGGERS = [
  "agentSpawn",
  "userPromptSubmit",
  "preToolUse",
  "postToolUse",
  "stop",
] as const;

/**
 * A `preToolUse` whose `postToolUse` never arrives — the call was rejected, or hooks are
 * registered for only some tools — must not grow the state file without bound.
 */
const MAX_OPEN_TOOLS = 64;

function capturing(): boolean {
  return flag("CAT_OTEL_CAPTURE_PROMPTS");
}

function encoded(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Opens a new turn. Kiro numbers nothing, so the counter is the identity. */
function openTurn(state: HookState): string {
  state.turn_seq += 1;
  const turnId = `t${state.turn_seq}`;
  const turn: TurnState = (state.turns[turnId] ??= {});
  turn.start_ns ??= nowNs().toString();
  state.last_turn_id = turnId;
  return turnId;
}

/**
 * The turn an event belongs to. A turn already reported cannot take more events: its span id
 * is deterministic, so reusing it would send a duplicate. That also covers the case where
 * `userPromptSubmit` is not registered and `stop` is the only turn boundary there is.
 */
function currentTurn(state: HookState): string {
  const turnId = state.last_turn_id;
  if (turnId && !state.turns[turnId]?.emitted) {
    return turnId;
  }
  return openTurn(state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits until the store holds the turn that just ended.
 *
 * Kiro persists the session store only **after** every `stop` hook has returned — measured at
 * ~20 ms after the hook process exited — so a `stop` hook can never read its own turn, no
 * matter how long it waits inside. That is what {@link deferKiroStop} is for: the waiting
 * happens in a process Kiro is not waiting on.
 *
 * The wait deliberately sits outside the state file's read-modify-write, so a concurrent hook
 * event has a few milliseconds to collide with rather than the whole budget.
 * `CAT_OTEL_KIRO_STORE_WAIT_MS` caps it.
 */
export async function awaitKiroStore(sessionId: string): Promise<void> {
  const deadline = Date.now() + Math.max(0, numberEnv("CAT_OTEL_KIRO_STORE_WAIT_MS", 2000));
  const path = kiroSessionPath(sessionId);
  const offset = loadState(sessionId, "kiro").turn_metadata_offset;
  while (Date.now() < deadline) {
    if (drainKiroSession(path, offset).turns.length > 0) {
      return;
    }
    await sleep(25);
  }
  debug(`session store did not report a turn session=${sessionId}`, "kiro");
}

/**
 * Hands the `stop` event to a detached copy of this hook and returns at once.
 *
 * Kiro writes the turn's usage only after the hook it is waiting on has exited (see
 * {@link awaitKiroStore}), so the work has to outlive that wait. The child inherits the
 * environment, reads the payload from its stdin, and does exactly what an inline `stop` would;
 * the parent adds no latency to the turn. Returns false when it could not be spawned, leaving
 * the caller to handle the event inline.
 */
export async function deferKiroStop(payload: HookPayload, entry: string): Promise<boolean> {
  const forwarded: HookPayload = {
    ...payload,
    // Only the captured content can make the payload large, and it is bounded by the same
    // limit the spans use — so it always fits in the pipe buffer and the write never blocks.
    assistant_response: capturing() ? text(payload.assistant_response) : null,
  };
  try {
    const child = spawn(process.execPath, [entry, "--runtime=kiro", "--deferred"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.unref();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdin.once("error", reject);
      child.stdin.end(`${JSON.stringify(forwarded)}\n`, () => resolve());
    });
    return true;
  } catch (error) {
    debug(`could not defer stop err=${String(error)}`, "kiro");
    return false;
  }
}

function mergeContext(state: HookState, context: RolloutContext): void {
  for (const [key, value] of Object.entries(context)) {
    if (value !== null && value !== undefined) {
      Object.assign(state.rollout_context, { [key]: value });
    }
  }
}

/**
 * Aligns the consumed count with the store without reporting anything, so a session resumed
 * with no state file of its own does not replay its whole history as one turn.
 */
function syncStore(state: HookState): void {
  const drained = drainKiroSession(kiroSessionPath(state.session_id), 0);
  mergeContext(state, drained.context);
  state.turn_metadata_offset = drained.offset;
  state.store_synced = true;
}

/**
 * Picks up the session-wide context — most of all the agent's name, which the spans of an
 * event that precedes the first `stop` would otherwise have to do without.
 */
function refreshContext(state: HookState): void {
  mergeContext(state, kiroSessionContext(kiroSessionPath(state.session_id)));
}

function handleSpawn(state: HookState, payload: HookPayload): OtlpSpan[] {
  state.started_at_ns = state.started_at_ns || nowNs().toString();
  state.cwd = payload.cwd;
  syncStore(state);
  return [];
}

function handlePrompt(state: HookState, payload: HookPayload): OtlpSpan[] {
  const turnId = openTurn(state);
  const turn: TurnState = (state.turns[turnId] ??= {});
  turn.start_ns = nowNs().toString();
  turn.model = payload.model || state.rollout_context.model || state.model;
  if (capturing()) {
    turn.prompt = text(payload.prompt);
  }
  return [];
}

function handlePreTool(state: HookState, payload: HookPayload): OtlpSpan[] {
  const name = payload.tool_name;
  if (!name) {
    return [];
  }
  state.open_tools.push({
    name,
    turnId: currentTurn(state),
    start_ns: nowNs().toString(),
    arguments: encoded(payload.tool_input),
  });
  if (state.open_tools.length > MAX_OPEN_TOOLS) {
    state.open_tools.splice(0, state.open_tools.length - MAX_OPEN_TOOLS);
  }
  return [];
}

/**
 * The `preToolUse` this `postToolUse` closes. Kiro issues no tool call id, so calls are
 * matched on name and arguments, and concurrent calls of one tool are served oldest first.
 */
function takeOpenTool(state: HookState, name: string, args: string | null): OpenToolState | null {
  let fallback = -1;
  for (let index = 0; index < state.open_tools.length; index += 1) {
    const open = state.open_tools[index];
    if (!open || open.name !== name) {
      continue;
    }
    if (open.arguments === args) {
      return state.open_tools.splice(index, 1)[0] ?? null;
    }
    if (fallback < 0) {
      fallback = index;
    }
  }
  return fallback < 0 ? null : (state.open_tools.splice(fallback, 1)[0] ?? null);
}

/**
 * Whether a tool failed, from Kiro's `tool_response`.
 *
 * Kiro reports a shell command that exited non-zero as a *completed* tool call and leaves the
 * exit status inside the response (`{"items":[{"Json":{"exit_status":"exit status: 3",...}}]}`),
 * so the response is searched for the markers that mean failure rather than trusted wholesale.
 */
function toolError(response: unknown, depth = 0): string | null {
  if (depth > 5 || response === null || typeof response !== "object") {
    return null;
  }
  if (Array.isArray(response)) {
    for (const item of response) {
      const found = toolError(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  for (const [key, value] of Object.entries(response as Record<string, unknown>)) {
    if (key === "exit_status" && typeof value === "string") {
      const code = /(-?\d+)/.exec(value)?.[1];
      if (code && code !== "0") {
        return `tool exited with code ${code}`;
      }
    }
    if (key === "is_error" && value === true) {
      return "tool failed";
    }
    if (key === "status" && typeof value === "string") {
      const status = value.toLowerCase();
      if (status === "error" || status === "failure" || status === "failed") {
        return "tool failed";
      }
    }
    if (key === "Err" || key === "Error") {
      return (encoded(value) || "tool failed").slice(0, 500);
    }
    const found = toolError(value, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function handlePostTool(
  state: HookState,
  payload: HookPayload,
  metrics: MetricStore,
): OtlpSpan[] {
  const name = payload.tool_name;
  if (!name) {
    return [];
  }
  const endNs = nowNs();
  const turnId = currentTurn(state);
  const args = encoded(payload.tool_input);
  const open = takeOpenTool(state, name, args);
  const windows = (state.turn_tools[turnId] ??= []);
  const previousEnd = toNs(windows[windows.length - 1]?.end_ns);
  // With no preToolUse to pair with, the execution is bounded by whatever came before it —
  // the previous tool, or the turn's start.
  const candidate =
    toNs(open?.start_ns) ?? previousEnd ?? toNs(state.turns[turnId]?.start_ns) ?? endNs;
  const startNs = candidate > endNs ? endNs : candidate;
  windows.push({ start_ns: startNs.toString(), end_ns: endNs.toString() });

  const capture = capturing();
  const model = state.rollout_context.model || payload.model || null;
  const failure = toolError(payload.tool_response);
  const agent = agentName(state, payload);
  recordTool(metrics, {
    agent,
    name,
    type: "function",
    errorType: failure ? ERROR_TYPE_OTHER : null,
    startNs,
    endNs,
  });
  return [
    span({
      traceId: traceId(state.session_id, turnId, "kiro"),
      // Kiro issues no tool call id, so the span id is derived from the call's position in
      // the turn, which is what makes it reproducible across the hook's separate processes.
      spanId: toolSpanId(state.session_id, `${turnId}:${windows.length}:${name}`, "kiro"),
      parentSpanId: turnSpanId(state.session_id, turnId, "kiro"),
      name: `execute_tool ${name}`,
      startNs,
      endNs,
      attributes: attrs([
        ...commonAttrs(state, payload, model),
        ["gen_ai.operation.name", "execute_tool"],
        ["gen_ai.tool.name", name],
        ["gen_ai.tool.type", "function"],
        // gen_ai.tool.call.id is left off: Kiro's hook payload carries no call identifier,
        // and an id this hook made up would not correlate with anything.
        ["gen_ai.tool.call.arguments", capture ? text(args) : null],
        ["gen_ai.tool.call.result", capture ? text(encoded(payload.tool_response)) : null],
        // The message text is high-cardinality, so it collapses to the well-known fallback
        // value; the text goes on the span status.
        ["error.type", failure ? ERROR_TYPE_OTHER : null],
        turnAttr(state, turnId),
      ]),
      error: failure,
    }),
  ];
}

interface TurnSummary {
  requests: number;
  toolCalls: number | null;
  attempts: number;
  usage: Usage;
  tokensReported: boolean;
  /** One credit amount per request, in request order. */
  credits: number[];
  model: string | null;
  startNs: bigint | null;
  endNs: bigint | null;
  contextPercent: number | null;
  endReason: string | null;
  error: string | null;
}

/**
 * Folds every metadata entry drained at one `stop` into the turn that ended. A turn normally
 * produces exactly one entry; extra entries (a subagent loop, or a previous turn whose
 * metadata landed late) belong to the same boundary and are summed rather than dropped.
 */
function summarize(turns: readonly KiroTurnMetadata[]): TurnSummary {
  const summary: TurnSummary = {
    requests: 0,
    toolCalls: null,
    attempts: 0,
    usage: emptyUsage(),
    tokensReported: false,
    credits: [],
    model: null,
    startNs: null,
    endNs: null,
    contextPercent: null,
    endReason: null,
    error: null,
  };
  for (const turn of turns) {
    summary.requests += turn.requests;
    summary.attempts += turn.attempts;
    summary.usage = addUsage(summary.usage, turn.usage);
    summary.tokensReported = summary.tokensReported || turn.tokensReported;
    summary.credits.push(...turn.credits);
    summary.model = turn.model || summary.model;
    summary.contextPercent = turn.contextPercent ?? summary.contextPercent;
    summary.endReason = turn.endReason ?? summary.endReason;
    summary.error ??= turn.error;
    if (turn.toolCalls !== null) {
      summary.toolCalls = (summary.toolCalls ?? 0) + turn.toolCalls;
    }
    if (turn.startNs !== null && (summary.startNs === null || turn.startNs < summary.startNs)) {
      summary.startNs = turn.startNs;
    }
    if (turn.endNs !== null && (summary.endNs === null || turn.endNs > summary.endNs)) {
      summary.endNs = turn.endNs;
    }
  }
  return summary;
}

function clamp(value: bigint, low: bigint, high: bigint): bigint {
  return value < low ? low : value > high ? high : value;
}

/** Tool executions that overlap ran as one batch, i.e. one LLM request asked for them all. */
function toolBatches(
  startNs: bigint,
  endNs: bigint,
  tools: readonly ToolWindow[],
): [bigint, bigint][] {
  const intervals: [bigint, bigint][] = [];
  for (const window of tools) {
    const from = toNs(window.start_ns);
    const to = toNs(window.end_ns);
    if (from === null || to === null) {
      continue;
    }
    const low = clamp(from, startNs, endNs);
    const high = clamp(to, startNs, endNs);
    // A tool that finished within the clock's resolution still separates the request that
    // asked for it from the one that read its result, so a zero-length window is kept.
    if (high >= low) {
      intervals.push([low, high]);
    }
  }
  intervals.sort((left, right) => (left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1));

  const merged: [bigint, bigint][] = [];
  for (const [from, to] of intervals) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) {
      last[1] = to > last[1] ? to : last[1];
      continue;
    }
    merged.push([from, to]);
  }
  return merged;
}

/**
 * Where each LLM request of the turn sits: the gaps the tool batches leave. N batches leave
 * N+1 gaps, which is how many requests an agent loop makes. When the counts disagree — a
 * retried request, or a tool whose hooks did not fire — the surplus requests share the last
 * gap rather than being placed somewhere invented.
 */
function requestWindows(
  startNs: bigint,
  endNs: bigint,
  tools: readonly ToolWindow[],
  count: number,
): [bigint, bigint][] {
  const gaps: [bigint, bigint][] = [];
  let cursor = startNs;
  for (const [from, to] of toolBatches(startNs, endNs, tools)) {
    gaps.push([cursor, from]);
    cursor = to;
  }
  gaps.push([cursor, endNs]);
  return Array.from(
    { length: count },
    (_, index) => gaps[Math.min(index, gaps.length - 1)] ?? [startNs, endNs],
  );
}

/**
 * One credit amount per request. A surplus amount joins the last request, so the per-request
 * figures always add up to the turn's total.
 */
function perRequestCredits(credits: readonly number[], count: number): number[] {
  const out = Array.from({ length: count }, (_, index) => credits[index] ?? 0);
  const surplus = credits.slice(count).reduce((total, value) => total + value, 0);
  if (surplus > 0 && count > 0) {
    out[count - 1] = (out[count - 1] ?? 0) + surplus;
  }
  return out;
}

/** Splits an integer total by weight, largest remainder first, so the parts sum exactly. */
function splitInteger(total: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) {
    return [];
  }
  const weight = weights.reduce((sum, value) => sum + value, 0);
  const exact = weights.map((value) => (weight > 0 ? (total * value) / weight : total / count));
  const parts = exact.map((value) => Math.floor(value));
  let remainder = total - parts.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const item of order) {
    if (remainder <= 0) {
      break;
    }
    parts[item.index] = (parts[item.index] ?? 0) + 1;
    remainder -= 1;
  }
  return parts;
}

/**
 * The turn's token counts apportioned over its requests, by credit share.
 *
 * Kiro reports tokens per turn only, and its credits are themselves derived from token usage,
 * so credits are the best available proxy for how the turn's tokens divide up. The result is
 * an estimate, flagged as such with `kiro.usage.tokens.apportioned`, and it sums back to the
 * turn total exactly.
 */
function splitUsage(usage: Usage, weights: readonly number[]): Usage[] {
  const columns = new Map<UsageKey, number[]>();
  for (const key of USAGE_KEYS) {
    columns.set(key, splitInteger(usage[key], weights));
  }
  return weights.map((_, index) => mapUsage((key) => columns.get(key)?.[index] ?? 0));
}

function handleStop(
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
): OtlpSpan[] {
  const path = kiroSessionPath(state.session_id);
  state.rollout_path = path;
  const drained = drainKiroSession(path, state.turn_metadata_offset);
  mergeContext(state, drained.context);
  // Without metadata the turn is still reported, from what the hooks themselves saw: the
  // boundary, its duration, and its tool calls. Only the usage is missing — and dropping the
  // turn instead would leave its execute_tool spans in a trace with no root. The consumed
  // count does not move, so usage that lands later joins the turn that follows.
  const reported = drained.turns.length > 0;
  if (!reported) {
    debug(`no turn metadata yet session=${state.session_id}`, "kiro");
  }

  let drainedTurns = drained.turns;
  if (!state.store_synced && reported) {
    // First contact with a session that already had history (a resume without state of our
    // own): only the turn that just ended is ours to report.
    state.store_synced = true;
    if (drainedTurns.length > 1) {
      debug(
        `skipping ${drainedTurns.length - 1} pre-existing turns session=${state.session_id}`,
        "kiro",
      );
      drainedTurns = drainedTurns.slice(-1);
    }
  }
  state.turn_metadata_offset = drained.offset;

  const summary = summarize(drainedTurns);
  const turnId = currentTurn(state);
  const turn: TurnState = state.turns[turnId] ?? {};
  const tools = state.turn_tools[turnId] ?? [];
  const endNs = summary.endNs ?? nowNs();
  const start = summary.startNs ?? toNs(turn.start_ns) ?? endNs;
  const startNs = start > endNs ? endNs : start;

  const capture = capturing();
  const place = placement();
  const model = summary.model || turn.model || payload.model || null;
  const provider = providerName(state);
  const contextWindow = state.rollout_context.context_window ?? null;
  // Requests are what the store counted; a store that reported only credits still gives one
  // amount per request, so the amounts alone can carry the count.
  const count = summary.requests > 0 ? summary.requests : summary.credits.length;
  const credits = perRequestCredits(summary.credits, count);
  const usages = splitUsage(summary.usage, credits);
  const windows = requestWindows(startNs, endNs, tools, count);

  const spans: OtlpSpan[] = [];
  let seq = state.llm_seq;
  let costTotal = 0;
  for (let index = 0; index < count; index += 1) {
    const [chatStart, chatEnd] = windows[index] ?? [startNs, endNs];
    const usage = usages[index] ?? emptyUsage();
    const amount = credits[index] ?? 0;
    const breakdown = creditCost(amount, pricing) ?? cost(usage, model, pricing);
    costTotal += breakdown.totalCost;
    seq += 1;
    const { attributes, event } = inferenceAttrs({
      pairs: [
        ...commonAttrs(state, payload, model),
        ["gen_ai.operation.name", "chat"],
        turnAttr(state, turnId),
        ["kiro.model.context_window", contextWindow],
        ...usageAttrs(usage, breakdown, "kiro", "inference", { tokens: summary.tokensReported }),
        ...creditAttrs(amount),
        // The turn's tokens were divided over its requests; only the turn total is measured.
        ["kiro.usage.tokens.apportioned", summary.tokensReported && count > 1 ? true : null],
      ],
      place,
      timeNs: chatEnd,
      // Kiro's store keeps no per-request message history, so only the turn span carries
      // content (from the hook payload).
      inputMessages: null,
      outputMessages: null,
    });
    spans.push(
      span({
        traceId: traceId(state.session_id, turnId, "kiro"),
        spanId: llmSpanId(state.session_id, seq, "kiro"),
        parentSpanId: turnSpanId(state.session_id, turnId, "kiro"),
        name: model ? `chat ${model}` : "chat",
        startNs: chatStart,
        endNs: chatEnd,
        attributes,
        events: [event],
        kind: SPAN_KIND_CLIENT, // A remote call to the model.
      }),
    );
    recordChat(metrics, {
      provider,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      startNs: chatStart,
      endNs: chatEnd,
      cost: breakdown.totalCost,
      currency: breakdown.currency,
      credits: amount,
      tokens: summary.tokensReported,
    });
  }
  state.llm_seq = seq;

  const turnCredits = summary.credits.reduce((total, value) => total + value, 0);
  const turnCost = creditCost(turnCredits, pricing) ?? cost(summary.usage, model, pricing);
  // Use the sum of the per-request costs, not a rounded single figure.
  turnCost.totalCost = costTotal;
  const toolCount = summary.toolCalls ?? tools.length;
  const agent = agentName(state, payload);
  const { attributes, event } = inferenceAttrs({
    pairs: [
      ...commonAttrs(state, payload, model, { agentSpan: true }),
      ["gen_ai.operation.name", "invoke_agent"],
      turnAttr(state, turnId),
      // Left off when no metadata was read: the request count is unknown then, not zero.
      ["kiro.llm.request.count", reported ? count : null],
      ["kiro.tool.call.count", toolCount],
      // Requests actually sent, retries included; higher than the request count on a retry.
      ["kiro.llm.request.attempts", summary.attempts > 0 ? summary.attempts : null],
      ["kiro.model.context_window", contextWindow],
      [
        "kiro.context.usage_percentage",
        summary.contextPercent === null ? null : double(summary.contextPercent),
      ],
      ["kiro.turn.end_reason", summary.endReason],
      ["error.type", summary.error ? ERROR_TYPE_OTHER : null],
      ...usageAttrs(summary.usage, turnCost, "kiro", "agent", { tokens: summary.tokensReported }),
      ...creditAttrs(turnCredits),
    ],
    place,
    timeNs: endNs,
    inputMessages: singleMessage("user", turn.prompt ?? null),
    outputMessages: singleMessage(
      "assistant",
      capture ? text(payload.assistant_response) : null,
    ),
  });
  spans.push(
    span({
      traceId: traceId(state.session_id, turnId, "kiro"),
      spanId: turnSpanId(state.session_id, turnId, "kiro"),
      parentSpanId: null,
      name: `invoke_agent ${agent}`,
      startNs,
      endNs,
      attributes,
      events: [event],
      error: summary.error,
    }),
  );
  recordTurn(metrics, {
    agent,
    inferenceCalls: count,
    toolCalls: toolCount,
    errorType: summary.error ? ERROR_TYPE_OTHER : null,
    startNs,
    endNs,
  });
  (state.turns[turnId] ??= {}).emitted = true;
  delete state.turn_tools[turnId];
  state.open_tools = state.open_tools.filter((open) => open.turnId !== turnId);
  state.last_turn_id = turnId;
  state.last_event_ns = nowNs().toString();
  state.session_totals = addUsage(state.session_totals, summary.usage);
  state.session_cost += costTotal;
  state.request_count += count;
  return spans;
}

/**
 * `kiro.usage.credits`. Kiro's own plan unit: neither tokens nor money, so no semconv
 * attribute fits and it stays an extension. It is what the service actually metered, unlike
 * every other cost figure this hook reports.
 */
function creditAttrs(credits: number): AttrPair[] {
  return credits > 0 ? [["kiro.usage.credits", double(credits)]] : [];
}

/** Dispatches one Kiro hook event. Returns the spans to send. */
export function processKiroEvent(
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
): OtlpSpan[] {
  switch (payload.hook_event_name) {
    case "agentSpawn":
      return handleSpawn(state, payload);
    case "userPromptSubmit":
      refreshContext(state);
      return handlePrompt(state, payload);
    case "preToolUse":
      return handlePreTool(state, payload);
    case "postToolUse":
      refreshContext(state);
      return handlePostTool(state, payload, metrics);
    case "stop":
      return handleStop(state, payload, pricing, metrics);
    default:
      return [];
  }
}
