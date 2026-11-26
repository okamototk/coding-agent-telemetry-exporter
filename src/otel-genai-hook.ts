#!/usr/bin/env node
/**
 * A coding-agent hook that exports token usage and cost as OTel GenAI traces.
 * Supported agents: Codex CLI / Claude Code / Kiro CLI
 *
 * Each CLI's command hook passes JSON on stdin and waits for the process to exit. The hook
 * therefore runs on Node's standard modules alone: it assembles OTLP/HTTP (JSON) itself and
 * POSTs it to the Collector, with no OTel SDK and no external dependencies.
 *
 *     hook event → stdin(JSON) → this hook → OTLP/HTTP JSON → OTel Collector
 *
 * The Codex hook payload carries no token usage — only boundary information such as
 * session_id, turn_id, model, cwd, and transcript_path. Usage lives in the `event_msg` /
 * `token_count` records of the rollout JSONL Codex writes itself (`transcript_path`,
 * usually `~/.codex/sessions/...jsonl`):
 *
 *     {"type":"event_msg","payload":{"type":"token_count","info":{
 *         "total_token_usage": {...cumulative...},
 *         "last_token_usage":  {...most recent request...},
 *         "model_context_window": 258400}}}
 *
 * Hence the hybrid design: boundaries come from the hook, usage from the rollout. On every
 * Stop / SessionEnd the rollout is read forward from the previous offset, emitting one span
 * per unprocessed `token_count` (one LLM request) and one span per function_call / output
 * pair (one tool execution).
 *
 * The span hierarchy sent. Trace IDs are derived deterministically from session_id +
 * turn_id, so one turn stays one trace even though each event runs in a throwaway process:
 *
 *     invoke_agent <agent>     (emitted at Stop; the turn's totals and cost)
 *     ├── chat <model>         (one rollout token_count = one LLM request)
 *     ├── execute_tool <name>  (one function_call / function_call_output pair)
 *     └── chat <model>
 *
 * `gen_ai.usage.input_tokens` is the input_tokens Codex reports verbatim: the token count
 * of the entire prompt, covering the system prompt (base_instructions / AGENTS.md), the
 * conversation so far, and the current user prompt. Within it, the cache-read portion goes
 * to `gen_ai.usage.cache_read.input_tokens` and the uncached portion to
 * `codex.usage.uncached_input_tokens`. Output includes reasoning tokens, broken out as
 * `gen_ai.usage.reasoning.output_tokens`.
 *
 * Kiro CLI works the same way with a different source and a different unit: its hooks carry
 * no usage either, so the turn totals come from the session store it writes itself
 * (`~/.kiro/sessions/cli/<session_id>.json`), and its tool spans come from the
 * `preToolUse` / `postToolUse` triggers. Kiro meters **credits**, not tokens — see agents/kiro/hook.ts.
 *
 * Cost is not in the released semconv, so it is reported through the `codex.usage.cost` /
 * `claude.usage.cost` / `kiro.usage.cost` extension attributes (`gen_ai.*` is OTel's
 * namespace and takes no custom attributes). Alongside them, the cost mapping of the
 * **unmerged draft**
 * https://github.com/open-telemetry/semantic-conventions-genai/pull/443 is emitted on the
 * chat spans — `gen_ai.usage.cost.amount` / `.currency` / `.source` plus the
 * `gen_ai.client.operation.cost` metric — which CAT_OTEL_COST_SEMCONV=0 turns off. The rate
 * table is pricing.json, overridable via CAT_OTEL_PRICING_FILE.
 *
 * The same observations also produce the semconv GenAI metrics
 * (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`,
 * `gen_ai.client.operation.cost`, `gen_ai.invoke_agent.*`,
 * `gen_ai.execute_tool.duration`) as delta histograms (see metrics.ts).
 *
 * The hook is always fail-open. Whether the Collector is down or the rollout is unreadable,
 * it exits 0 and never halts the agent's session.
 *
 * Environment variables:
 *     CAT_OTEL_ENDPOINT               OTLP/HTTP base destination, /v1/<signal> appended.
 *                                     Default http://localhost:4318 (also reads
 *                                     OTEL_EXPORTER_OTLP_ENDPOINT; the per-signal
 *                                     OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is a full URL and
 *                                     keeps its own path)
 *     CAT_OTEL_METRICS                0 to stop sending metrics (default 1)
 *     CAT_OTEL_METRICS_ENDPOINT       Send metrics to a separate destination, as a full URL
 *                                     (also reads OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
 *     CAT_OTEL_HEADERS                Extra headers, "k=v,k2=v2"; values are
 *                                     percent-encoded, per OTLP
 *                                     (also reads OTEL_EXPORTER_OTLP_HEADERS)
 *     CAT_OTEL_TIMEOUT                POST timeout in seconds. Default 3
 *     CAT_OTEL_SERVICE_NAME           service.name. Default codex / claude-code / kiro-cli
 *     CAT_OTEL_RESOURCE_ATTRIBUTES    Extra resource attributes, "k=v,k2=v2"
 *                                     (also reads OTEL_RESOURCE_ATTRIBUTES)
 *     CAT_OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES
 *                                     0 to stop copying those attributes onto every metric
 *                                     data point; they stay on the resource either way
 *                                     (default 1, also reads
 *                                      OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES)
 *     CAT_OTEL_PRICING_FILE           Path to the rate table JSON. Default: the bundled
 *                                     pricing.json
 *     CAT_OTEL_COST_SEMCONV           0 to stop emitting the draft gen_ai.usage.cost.*
 *                                     attributes and the gen_ai.client.operation.cost
 *                                     metric (default 1). The {runtime}.usage.cost
 *                                     extensions are emitted either way
 *     CAT_OTEL_COST_BREAKDOWN         1 to add the per-class cost breakdown of
 *                                     https://github.com/open-telemetry/semantic-conventions-genai/issues/484
 *                                     (default 0; that issue's classes are still open)
 *     CAT_OTEL_CAPTURE_PROMPTS        1 to put prompt and response content on the spans
 *                                     (default 0 = metadata and tokens only)
 *     CAT_OTEL_MESSAGES_MODE          Where to put attributes semconv also defines on the
 *                                     event (content, model name, token counts, ...):
 *                                     attribute (default) / event / both. `event` emits
 *                                     gen_ai.client.inference.operation.details as a trace
 *                                     event and moves those attributes onto it (content
 *                                     becomes a structured value; attributes Required on
 *                                     the span stay on the span too)
 *     CAT_OTEL_CONTENT_MAX_CHARS      Per-attribute limit for captured content.
 *                                     Default 20000
 *     CAT_OTEL_STATE_DIR              State directory. Defaults per runtime
 *     CAT_OTEL_KIRO_CREDIT_USD        Kiro only: what one credit costs. Unset (default), no
 *                                     monetary cost is reported and only the credits are
 *     CAT_OTEL_KIRO_SESSIONS_DIR      Kiro only: where the session store lives.
 *                                     Default $KIRO_HOME/sessions/cli
 *     CAT_OTEL_KIRO_STORE_WAIT_MS     Kiro only: how long to wait for the session store to be
 *                                     written after a turn. Default 2000
 *     CAT_OTEL_KIRO_DEFER             Kiro only: 0 to handle `stop` inline instead of in a
 *                                     detached process (default 1). Inline blocks the turn
 *                                     for the wait above and still misses the last turn,
 *                                     because Kiro writes the store after the hook exits
 *     CAT_OTEL_DEBUG                  1 to log details to hook.log in the state directory
 *     CAT_OTEL_DISABLE                1 to return immediately without doing anything
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { drainClaudeTranscript } from "./agents/claude/transcript.ts";
import { debug, env, flag } from "./core/env.ts";
import { llmSpanId, toolSpanId, traceId, turnSpanId } from "./core/ids.ts";
import {
  ERROR_TYPE_OTHER,
  exportMetrics,
  newMetricStore,
  recordChat,
  recordTool,
  recordTurn,
  type MetricStore,
} from "./otel/metrics.ts";
import {
  attrs,
  exportSpans,
  span,
  SPAN_KIND_CLIENT,
  type OtlpSpan,
} from "./otel/otlp.ts";
import { cost, loadPricing, type CostBreakdown, type Pricing } from "./core/pricing.ts";
import { drainRollout, perRequestUsage, resolveRollout } from "./agents/codex/rollout.ts";
import {
  agentName,
  commonAttrs,
  inferenceAttrs,
  normalizedMessages,
  placement,
  providerName,
  singleMessage,
  text,
  turnAttr,
  usageAttrs,
} from "./otel/spans.ts";
import { withState } from "./core/state.ts";
import { nowNs, toNs } from "./core/time.ts";
import {
  addUsage,
  emptyBucket,
  mapUsage,
  type AgentRuntime,
  type HookPayload,
  type HookState,
  type SerializedTurnBucket,
  type TurnBucket,
  type TurnState,
} from "./core/types.ts";
import { awaitKiroStore, deferKiroStop, KIRO_TRIGGERS, processKiroEvent } from "./agents/kiro/hook.ts";

/**
 * Only Stop's stdout is meant to be parsed as JSON by Codex; exiting silently is safer for
 * every other event. session-end has no output schema, and returning stray keys to an event
 * declared additionalProperties:false counts as invalid JSON output.
 */
const JSON_RESPONSE_EVENTS = new Set(["Stop"]);

type Handler = (
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
) => OtlpSpan[];

interface SyncResult {
  spans: OtlpSpan[];
  /** Turn ID → totals for the LLM requests in that turn, in insertion order. */
  perTurn: Map<string, TurnBucket>;
}

function enabled(name: string): boolean {
  return flag(`CAT_OTEL_${name}`);
}

function turnIdOf(payload: HookPayload, state: HookState): string {
  return payload.prompt_id || payload.turn_id || state.last_turn_id || "unknown";
}

function mergeBucket(into: TurnBucket, source: TurnBucket): void {
  into.usage = addUsage(into.usage, source.usage);
  into.cost += source.cost;
  into.inputCost = sumOrNull(into.inputCost, source.inputCost);
  into.outputCost = sumOrNull(into.outputCost, source.outputCost);
  into.count += source.count;
  into.toolCount += source.toolCount;
  into.model = source.model || into.model;
  into.endNs =
    source.endNs !== null && (into.endNs === null || source.endNs > into.endNs)
      ? source.endNs
      : into.endNs;
}

function sumOrNull(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

/**
 * The turn's cost: the per-request sums where they are known. Recomputing the split from the
 * summed usage is the fallback, for a turn partly restored from state that predates them.
 */
function turnCost(bucket: TurnBucket, model: string | null, pricing: Pricing): CostBreakdown {
  const breakdown = cost(bucket.usage, model, pricing);
  // Use the sum of the per-request costs, not a rounded single-request figure.
  breakdown.totalCost = bucket.cost;
  if (bucket.inputCost !== null && bucket.outputCost !== null) {
    breakdown.inputCost = bucket.inputCost;
    breakdown.outputCost = bucket.outputCost;
  }
  return breakdown;
}

function serialized(bucket: TurnBucket): SerializedTurnBucket {
  return {
    usage: bucket.usage,
    cost: bucket.cost,
    input_cost: bucket.inputCost,
    output_cost: bucket.outputCost,
    count: bucket.count,
    toolCount: bucket.toolCount,
    model: bucket.model,
    end_ns: bucket.endNs?.toString() ?? null,
  };
}

function restored(bucket: SerializedTurnBucket): TurnBucket {
  return {
    usage: bucket.usage,
    cost: bucket.cost,
    inputCost: typeof bucket.input_cost === "number" ? bucket.input_cost : null,
    outputCost: typeof bucket.output_cost === "number" ? bucket.output_cost : null,
    count: bucket.count,
    toolCount: bucket.toolCount,
    model: bucket.model,
    endNs: toNs(bucket.end_ns),
  };
}

function mergePending(state: HookState, perTurn: Map<string, TurnBucket>): void {
  for (const [turnId, saved] of Object.entries(state.pending_turns)) {
    const bucket = perTurn.get(turnId);
    if (bucket) {
      mergeBucket(bucket, restored(saved));
    } else {
      perTurn.set(turnId, restored(saved));
    }
    delete state.pending_turns[turnId];
  }
}

function stashPending(state: HookState, perTurn: Map<string, TurnBucket>): void {
  for (const [turnId, bucket] of perTurn) {
    const existing = state.pending_turns[turnId];
    if (existing) {
      const merged = restored(existing);
      mergeBucket(merged, bucket);
      state.pending_turns[turnId] = serialized(merged);
    } else {
      state.pending_turns[turnId] = serialized(bucket);
    }
  }
}

/** Points the session at `path`, reading it from the start only if it is a different file. */
function useRollout(state: HookState, path: string | null): void {
  if (path && path !== state.rollout_path) {
    state.rollout_path = path;
    state.rollout_offset = 0;
  }
}

/** Reads the rollout forward, returning the LLM request spans and the per-turn totals. */
function syncRollout(
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
): SyncResult {
  const spans: OtlpSpan[] = [];
  const perTurn = new Map<string, TurnBucket>();

  const path =
    state.runtime === "claude"
      ? payload.agent_transcript_path || payload.transcript_path || state.rollout_path
      : resolveRollout(payload, state);
  if (!path) {
    debug(`transcript not found session=${state.session_id}`, state.runtime);
    return { spans, perTurn };
  }
  if (state.runtime === "claude") {
    // Subagent transcripts come and go here; the cursors are per file, not this offset.
    state.rollout_path = path;
  } else {
    useRollout(state, path);
  }

  const capture = enabled("CAPTURE_PROMPTS");
  const place = placement();
  const fallbackTurn = turnIdOf(payload, state);
  const drained =
    state.runtime === "claude"
      ? drainClaudeTranscript(path, state, capture, fallbackTurn)
      : drainRollout(path, state.rollout_offset, capture);
  for (const [key, value] of Object.entries(drained.context)) {
    if (value !== null && value !== undefined) {
      Object.assign(state.rollout_context, { [key]: value });
    }
  }
  if (state.runtime === "codex") {
    state.rollout_offset = drained.offset;
  }
  if (drained.requests.length === 0 && drained.tools.length === 0) {
    return { spans, perTurn };
  }

  let cumulative = state.cumulative;
  let seq = state.llm_seq;
  // An LLM span's start time is approximated by the previous request's end time, or the
  // turn's start time. Codex does not record a per-request start time in the rollout.
  const previousEnd = new Map<string, bigint>();
  let emitted = 0;

  for (const request of drained.requests) {
    const resolved = perRequestUsage(request, cumulative);
    if (resolved === null) {
      continue; // A duplicate token_count.
    }
    const usage = resolved.usage;
    cumulative = resolved.cumulative;
    emitted += 1;

    const turnId = request.turnId || fallbackTurn;
    const model = request.model || state.rollout_context.model || payload.model || null;
    const breakdown = cost(usage, model, pricing, request.speed);

    const turn: TurnState = state.turns[turnId] ?? {};
    const endNs = request.endNs ?? nowNs();
    const candidateStart = previousEnd.get(turnId) ?? toNs(turn.start_ns) ?? endNs;
    const startNs = candidateStart > endNs ? endNs : candidateStart;
    previousEnd.set(turnId, endNs);

    // The counter is only a fallback now, for a source that offers no key of its own.
    seq += 1;
    const { attributes, event } = inferenceAttrs({
      pairs: [
        ...commonAttrs(state, payload, model),
        ["gen_ai.operation.name", "chat"],
        turnAttr(state, turnId),
        ["gen_ai.request.reasoning.level", request.effort],
        [`${state.runtime}.request.speed`, request.speed ?? null],
        [`${state.runtime}.model.context_window`, request.contextWindow],
        ...usageAttrs(usage, breakdown, state.runtime),
      ],
      place,
      timeNs: endNs,
      inputMessages: capture ? normalizedMessages(request.inputMessages) : null,
      outputMessages: capture ? normalizedMessages(request.outputMessages) : null,
    });
    spans.push(
      span({
        traceId: traceId(state.session_id, turnId, state.runtime),
        spanId: llmSpanId(state.session_id, request.spanKey ?? seq, state.runtime),
        parentSpanId: turnSpanId(state.session_id, turnId, state.runtime),
        name: model ? `chat ${model}` : "chat",
        startNs,
        endNs,
        attributes,
        events: [event],
        kind: SPAN_KIND_CLIENT, // A remote call to the model.
      }),
    );
    recordChat(metrics, {
      provider: providerName(state),
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      startNs,
      endNs,
      cost: breakdown.totalCost,
      currency: breakdown.currency,
    });

    let bucket = perTurn.get(turnId);
    if (!bucket) {
      bucket = emptyBucket(model);
      perTurn.set(turnId, bucket);
    }
    bucket.usage = addUsage(bucket.usage, usage);
    bucket.cost += breakdown.totalCost;
    bucket.inputCost = sumOrNull(bucket.inputCost, breakdown.inputCost);
    bucket.outputCost = sumOrNull(bucket.outputCost, breakdown.outputCost);
    bucket.count += 1;
    bucket.model = model || bucket.model;
    bucket.endNs = endNs;
  }

  for (const tool of drained.tools) {
    const turnId = tool.turnId || fallbackTurn;
    const model = state.rollout_context.model || payload.model || null;
    spans.push(
      span({
        traceId: traceId(state.session_id, turnId, state.runtime),
        spanId: toolSpanId(state.session_id, tool.callId, state.runtime),
        parentSpanId: turnSpanId(state.session_id, turnId, state.runtime),
        name: `execute_tool ${tool.name}`,
        startNs: tool.startNs,
        endNs: tool.endNs,
        attributes: attrs([
          ...commonAttrs(state, payload, model),
          ["gen_ai.operation.name", "execute_tool"],
          ["gen_ai.tool.name", tool.name],
          ["gen_ai.tool.type", "function"],
          ["gen_ai.tool.call.id", tool.callId],
          ["gen_ai.tool.call.arguments", capture ? text(tool.arguments) : null],
          ["gen_ai.tool.call.result", capture ? text(tool.result) : null],
          // Conditionally Required on error. The message text is high-cardinality, so it
          // collapses to the well-known fallback value; the text goes on the span status.
          ["error.type", tool.error ? ERROR_TYPE_OTHER : null],
          turnAttr(state, turnId),
        ]),
        error: tool.error,
      }),
    );
    recordTool(metrics, {
      agent: agentName(state, payload),
      name: tool.name,
      type: "function",
      // The error text is high-cardinality, so error.type collapses to the well-known
      // fallback value; the text is already on the span status.
      errorType: tool.error ? ERROR_TYPE_OTHER : null,
      startNs: tool.startNs,
      endNs: tool.endNs,
    });

    let bucket = perTurn.get(turnId);
    if (!bucket) {
      bucket = emptyBucket(model);
      perTurn.set(turnId, bucket);
    }
    bucket.toolCount += 1;
    bucket.model = model || bucket.model;
    bucket.endNs =
      bucket.endNs === null || tool.endNs > bucket.endNs ? tool.endNs : bucket.endNs;
  }

  state.cumulative = cumulative;
  state.llm_seq = seq;
  state.session_totals = addUsage(
    state.session_totals,
    mapUsage((key) => [...perTurn.values()].reduce((total, bucket) => total + bucket.usage[key], 0)),
  );
  state.session_cost += [...perTurn.values()].reduce((total, bucket) => total + bucket.cost, 0);
  state.request_count += emitted;
  return { spans, perTurn };
}

function handleSessionStart(state: HookState, payload: HookPayload): OtlpSpan[] {
  state.started_at_ns = state.started_at_ns || nowNs().toString();
  state.cwd = payload.cwd;
  state.model = payload.model;
  state.source = payload.source;
  // resume / clear / compact / fork may or may not switch files: Claude Code keeps appending
  // to the same transcript after /compact and --resume, and a resumed Codex session appends
  // to its rollout. Only a different file starts from offset 0. Rewinding the same file would
  // re-read requests that were already sent — Claude's cursor would lose its seen ids, and a
  // Codex total below the saved cumulative would pass for a counter reset — so they would be
  // emitted and billed twice. A file rewritten in place is caught by its size instead (see
  // drainRollout / drainClaudeTranscript). Claude's cursors are per file, so nothing to do.
  useRollout(state, payload.transcript_path ?? null);
  return [];
}

function handleUserPrompt(state: HookState, payload: HookPayload): OtlpSpan[] {
  const turnId = turnIdOf(payload, state);
  const turn: TurnState = (state.turns[turnId] ??= {});
  turn.start_ns = turn.start_ns || nowNs().toString();
  turn.model = payload.model || state.model;
  if (enabled("CAPTURE_PROMPTS")) {
    turn.prompt = text(payload.prompt);
  }
  state.last_turn_id = turnId;
  return [];
}

function handleStop(
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
): OtlpSpan[] {
  const { spans, perTurn } = syncRollout(state, payload, pricing, metrics);
  mergePending(state, perTurn);
  const turnId = turnIdOf(payload, state);
  const capture = enabled("CAPTURE_PROMPTS");
  const place = placement();

  // What belongs to this turn goes on its turn span. Leftovers from other turns become
  // separate spans keyed by the rollout's turn_id, so they are all handled together.
  const ordered = [...perTurn.entries()].sort(
    (left, right) => Number(left[0] !== turnId) - Number(right[0] !== turnId),
  );
  for (const [targetTurn, bucket] of ordered) {
    const turn: TurnState = state.turns[targetTurn] ?? {};
    if (turn.emitted) {
      continue;
    }
    const model = bucket.model || turn.model || payload.model || null;
    const breakdown = turnCost(bucket, model, pricing);
    const startNs = toNs(turn.start_ns) ?? bucket.endNs ?? nowNs();
    const endNs = targetTurn === turnId ? nowNs() : bucket.endNs ?? nowNs();

    const errors = state.rollout_context.errors ?? [];
    const { attributes, event } = inferenceAttrs({
      pairs: [
        ...commonAttrs(state, payload, model, { agentSpan: true }),
        ["gen_ai.operation.name", "invoke_agent"],
        turnAttr(state, targetTurn),
        [`${state.runtime}.llm.request.count`, bucket.count],
        [`${state.runtime}.tool.call.count`, bucket.toolCount],
        ["error.type", errors.length > 0 ? ERROR_TYPE_OTHER : null],
        ...usageAttrs(bucket.usage, breakdown, state.runtime, "agent"),
      ],
      place,
      timeNs: endNs,
      inputMessages: singleMessage("user", turn.prompt ?? null),
      outputMessages: singleMessage(
        "assistant",
        capture && targetTurn === turnId ? text(payload.last_assistant_message) : null,
      ),
    });
    spans.push(
      span({
        traceId: traceId(state.session_id, targetTurn, state.runtime),
        spanId: turnSpanId(state.session_id, targetTurn, state.runtime),
        parentSpanId: null,
        name: `invoke_agent ${agentName(state, payload)}`,
        startNs,
        endNs,
        attributes,
        events: [event],
        error: errors.length > 0 ? (errors[errors.length - 1] ?? null) : null,
      }),
    );
    recordTurn(metrics, {
      agent: agentName(state, payload),
      inferenceCalls: bucket.count,
      toolCalls: bucket.toolCount,
      errorType: errors.length > 0 ? ERROR_TYPE_OTHER : null,
      startNs,
      endNs,
    });
    (state.turns[targetTurn] ??= {}).emitted = true;
  }

  state.last_turn_id = turnId;
  state.last_event_ns = nowNs().toString();
  delete state.rollout_context.errors;
  return spans;
}

function handleSessionEnd(
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
): OtlpSpan[] {
  // Also collects usage from turns that ended without a Stop, e.g. after an interrupt.
  const { spans, perTurn } = syncRollout(state, payload, pricing, metrics);
  mergePending(state, perTurn);
  const place = placement();
  for (const [targetTurn, bucket] of perTurn) {
    const turn: TurnState = state.turns[targetTurn] ?? {};
    if (turn.emitted) {
      // The turn span was already sent at Stop with a deterministic span ID. A second span
      // reusing that ID would be a duplicate, so late-arriving usage only lands on the
      // child chat spans and the internal session totals.
      continue;
    }
    const model = bucket.model || turn.model || null;
    const breakdown = turnCost(bucket, model, pricing);
    const endNs = bucket.endNs ?? nowNs();
    const startNs = toNs(turn.start_ns) ?? endNs;
    const { attributes, event } = inferenceAttrs({
      pairs: [
        ...commonAttrs(state, payload, model, { agentSpan: true }),
        ["gen_ai.operation.name", "invoke_agent"],
        turnAttr(state, targetTurn),
        [`${state.runtime}.llm.request.count`, bucket.count],
        [`${state.runtime}.tool.call.count`, bucket.toolCount],
        ...usageAttrs(bucket.usage, breakdown, state.runtime, "agent"),
      ],
      place,
      timeNs: endNs,
    });
    spans.push(
      span({
        traceId: traceId(state.session_id, targetTurn, state.runtime),
        spanId: turnSpanId(state.session_id, targetTurn, state.runtime),
        parentSpanId: null,
        name: `invoke_agent ${agentName(state, payload)}`,
        startNs,
        endNs,
        attributes,
        events: [event],
      }),
    );
    recordTurn(metrics, {
      agent: agentName(state, payload),
      inferenceCalls: bucket.count,
      toolCalls: bucket.toolCount,
      errorType: null,
      startNs,
      endNs,
    });
    (state.turns[targetTurn] ??= {}).emitted = true;
  }

  return spans;
}

function handleSubagentStop(
  state: HookState,
  payload: HookPayload,
  pricing: Pricing,
  metrics: MetricStore,
): OtlpSpan[] {
  const { spans, perTurn } = syncRollout(state, payload, pricing, metrics);
  stashPending(state, perTurn);
  return spans;
}

const HANDLERS: Record<string, Handler> = {
  SessionStart: (state, payload) => handleSessionStart(state, payload),
  UserPromptSubmit: (state, payload) => handleUserPrompt(state, payload),
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
  SubagentStop: handleSubagentStop,
};

const DEFAULT_SERVICE: Record<AgentRuntime, string> = {
  codex: "codex",
  claude: "claude-code",
  kiro: "kiro-cli",
};

/**
 * Kiro's `agentSpawn` payload carries no session_id, only the `KIRO_SESSION_ID` the CLI
 * exports into the hook's environment, so the environment is the fallback.
 */
function sessionIdOf(payload: HookPayload, runtime: AgentRuntime): string {
  if (payload.session_id) {
    return payload.session_id;
  }
  return runtime === "kiro" ? env(["KIRO_SESSION_ID"]) : "";
}

/** Processes a payload and returns the spans sent. Exported for the tests. */
export async function processPayload(
  payload: HookPayload,
  runtime: AgentRuntime = "codex",
): Promise<OtlpSpan[]> {
  const event = payload.hook_event_name ?? "";
  const known =
    runtime === "kiro"
      ? (KIRO_TRIGGERS as readonly string[]).includes(event)
      : event in HANDLERS;
  const sessionId = sessionIdOf(payload, runtime);
  if (!known || !sessionId) {
    return [];
  }

  const pricing = loadPricing();
  const metrics = newMetricStore();
  // The state file's read-modify-write is serialized against other hook processes; the export
  // below deliberately sits outside it, being the slow part and needing no state.
  const spans = withState(sessionId, runtime, (state) =>
    runtime === "kiro"
      ? processKiroEvent(state, payload, pricing, metrics)
      : (HANDLERS[event] as Handler)(state, payload, pricing, metrics),
  );
  const serviceName = env(["CAT_OTEL_SERVICE_NAME"], DEFAULT_SERVICE[runtime]);
  // Traces and metrics are separate signals with separate endpoints, so send in parallel.
  await Promise.all([
    exportSpans(spans, serviceName),
    flag("CAT_OTEL_METRICS", true) ? exportMetrics(metrics, serviceName) : Promise.resolve(),
  ]);
  return spans;
}

function runtimeOf(argv: readonly string[]): AgentRuntime {
  for (const runtime of ["claude", "kiro"] as const) {
    if (argv.includes(`--runtime=${runtime}`)) {
      return runtime;
    }
  }
  return "codex";
}

/**
 * Kiro's `stop`: usually handed to a detached copy of this hook, because Kiro writes the
 * turn's usage only once the hook it is waiting on has exited. Returns true when the event was
 * passed on and this process is done with it. `CAT_OTEL_KIRO_DEFER=0` keeps it inline instead,
 * which then blocks the turn for as long as it waits on the store.
 */
async function handedOff(payload: HookPayload, runtime: AgentRuntime): Promise<boolean> {
  const entry = process.argv[1];
  if (runtime !== "kiro" || payload.hook_event_name !== "stop" || entry === undefined) {
    return false;
  }
  if (process.argv.includes("--deferred")) {
    // This *is* the detached copy: wait for the store, then handle the event normally.
    await awaitKiroStore(sessionIdOf(payload, runtime));
    return false;
  }
  if (!flag("CAT_OTEL_KIRO_DEFER", true)) {
    await awaitKiroStore(sessionIdOf(payload, runtime));
    return false;
  }
  return deferKiroStop(payload, entry);
}

export async function main(): Promise<number> {
  const runtime = runtimeOf(process.argv);
  let event: string | null = null;
  try {
    const raw = readFileSync(0, "utf8");
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const payload = parsed as HookPayload;
      event = payload.hook_event_name ?? null;
      if (!enabled("DISABLE")) {
        if (await handedOff(payload, runtime)) {
          debug(`event=${event} deferred`, runtime);
        } else {
          const spans = await processPayload(payload, runtime);
          debug(`event=${event} spans=${spans.length}`, runtime);
        }
      }
    }
  } catch (error) {
    // fail-open: never halt the agent's session.
    debug(`hook error event=${event} err=${String(error)}`, runtime);
  }

  if (runtime === "codex" && event !== null && JSON_RESPONSE_EVENTS.has(event)) {
    process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
  }
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = await main();
}
