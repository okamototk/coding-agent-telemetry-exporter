/** Builds span attributes. All mapping onto the GenAI semconv lives here. */

import { env } from "./env.ts";
import { attrs, double, structuredAttr, type Attr, type AttrValue, type SpanEvent } from "./otlp.ts";
import type { CostBreakdown } from "./pricing.ts";
import type { AgentRuntime, GenAiMessage, HookPayload, HookState, Usage } from "./types.ts";

export type AttrPair = readonly [string, AttrValue];

/**
 * The semconv "details of a completed GenAI request" event. The name MUST be this value.
 * It is meant to be emitted as a log record, but this hook only sends traces, so it rides
 * on the corresponding span as a trace event.
 */
export const INFERENCE_EVENT_NAME = "gen_ai.client.inference.operation.details";

/**
 * The keys semconv defines as attributes of the event above, taken verbatim from its
 * attribute table. In event mode, attributes in this set are routed to the event. Keys not
 * yet emitted are listed too, so anything added later moves to the event automatically.
 * `gen_ai.prompt.variable` is a template attribute (it takes a `<key>`) and is excluded.
 */
const EVENT_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "error.type",
  "gen_ai.conversation.compacted",
  "gen_ai.conversation.id",
  "gen_ai.input.messages",
  "gen_ai.operation.name",
  "gen_ai.output.messages",
  "gen_ai.output.type",
  "gen_ai.prompt.name",
  "gen_ai.prompt.version",
  "gen_ai.provider.name",
  "gen_ai.request.choice.count",
  "gen_ai.request.frequency_penalty",
  "gen_ai.request.max_tokens",
  "gen_ai.request.model",
  "gen_ai.request.presence_penalty",
  "gen_ai.request.previous_response.id",
  "gen_ai.request.reasoning.level",
  "gen_ai.request.seed",
  "gen_ai.request.stop_sequences",
  "gen_ai.request.stream",
  "gen_ai.request.temperature",
  "gen_ai.request.top_k",
  "gen_ai.request.top_p",
  "gen_ai.response.finish_reasons",
  "gen_ai.response.id",
  "gen_ai.response.model",
  "gen_ai.response.time_to_first_chunk",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.usage.audio.cache_read.input_tokens",
  "gen_ai.usage.audio.input_tokens",
  "gen_ai.usage.audio.output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_write.input_tokens",
  "gen_ai.usage.image.cache_read.input_tokens",
  "gen_ai.usage.image.input_tokens",
  "gen_ai.usage.image.output_tokens",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.reasoning.output_tokens",
  "gen_ai.usage.text.cache_read.input_tokens",
  "gen_ai.usage.text.input_tokens",
  "gen_ai.usage.text.output_tokens",
  "server.address",
  "server.port",
]);

/**
 * Attributes semconv marks Required / Conditionally Required on the span. These stay on
 * the span even in event mode: dropping them would make the span violate semconv, and a
 * GenAI-aware backend would no longer recognize it.
 */
const SPAN_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.conversation.id",
  "gen_ai.request.model",
  // Conditionally Required: present only on error, and needed alongside the span status.
  "error.type",
]);

/** Truncates captured content to the per-attribute limit. */
export function text(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  return value.slice(0, contentMaximum());
}

/** A single message in the semconv v1.37 gen_ai.{input,output}.messages shape. */
export function singleMessage(role: string, content: string | null): GenAiMessage[] | null {
  if (!content) {
    return null;
  }
  return [{ role, parts: [{ type: "text", content }] }];
}

/**
 * Fits multiple messages within the limit. When it is exceeded the most recent messages
 * are kept, and whole messages are dropped so the JSON string is never cut mid-structure.
 */
export function normalizedMessages(value: GenAiMessage[]): GenAiMessage[] | null {
  if (value.length === 0) {
    return null;
  }
  const maximum = contentMaximum();
  const normalized = value.map((message) => ({
    role: message.role,
    parts: message.parts.map((part) => {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(part)) {
        out[key] = typeof item === "string" ? text(item) : item;
      }
      return out;
    }),
  }));
  let encoded = JSON.stringify(normalized);
  while (encoded.length > maximum && normalized.length > 1) {
    normalized.shift();
    encoded = JSON.stringify(normalized);
  }
  if (encoded.length <= maximum) {
    return normalized;
  }

  const only = normalized[0];
  if (!only) {
    return null;
  }
  const compact = {
    role: only.role,
    parts: [{ type: "text", content: "[message truncated]" }],
  };
  encoded = JSON.stringify([compact]);
  return encoded.length <= maximum ? [compact] : null;
}

/**
 * The form used on span attributes. An OTLP span attribute cannot express an array of
 * objects, so it becomes a JSON string (semconv allows a JSON string on spans as a MAY).
 */
function messagesJson(value: GenAiMessage[] | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export interface Placement {
  /** Put semconv attributes on the span (the default, and the original behavior). */
  attribute: boolean;
  /** Put them on the gen_ai.client.inference.operation.details event. */
  event: boolean;
}

/**
 * Where to put attributes semconv also defines on the event. Both the span and the event
 * are allowed; on the event, message content MUST be a structured value, so the encoding
 * differs as well.
 */
export function placement(): Placement {
  const raw = env(["CAT_OTEL_MESSAGES_MODE"]).trim().toLowerCase();
  if (raw === "event" || raw === "events") {
    return { attribute: false, event: true };
  }
  if (raw === "both" || raw === "all") {
    return { attribute: true, event: true };
  }
  // An unknown value falls back to span attributes: a typo must not silently drop them.
  return { attribute: true, event: false };
}

/** The key to use on the event, or null when the event defines no such attribute (span only). */
function eventKeyOf(key: string): string | null {
  return EVENT_ATTRIBUTE_KEYS.has(key) ? key : null;
}

export interface InferenceInput {
  /** Candidate attribute pairs for the span. Message content is passed via messages. */
  pairs: readonly AttrPair[];
  place: Placement;
  /** The event timestamp; the span's end time is used. */
  timeNs: bigint;
  inputMessages?: GenAiMessage[] | null;
  outputMessages?: GenAiMessage[] | null;
}

export interface InferenceAttrs {
  attributes: Attr[];
  /** The trace event, or null when events are off or there is nothing to put on one. */
  event: SpanEvent | null;
}

/**
 * Builds the attributes and event for an inference span (chat / invoke_agent). Keys
 * semconv defines as event attributes are routed according to `place`; extensions such as
 * cost and `codex.*` always stay on the span attributes.
 */
export function inferenceAttrs(input: InferenceInput): InferenceAttrs {
  const { place } = input;
  const spanPairs: AttrPair[] = [];
  const eventPairs: AttrPair[] = [];
  for (const pair of input.pairs) {
    const [key, value] = pair;
    const eventKey = place.event ? eventKeyOf(key) : null;
    if (eventKey === null) {
      spanPairs.push(pair);
      continue;
    }
    eventPairs.push([eventKey, value]);
    if (place.attribute || SPAN_REQUIRED_KEYS.has(key)) {
      spanPairs.push(pair);
    }
  }

  const inputMessages = input.inputMessages ?? null;
  const outputMessages = input.outputMessages ?? null;
  if (place.attribute) {
    // A span attribute cannot express an array of objects, so use a JSON string.
    spanPairs.push(
      ["gen_ai.input.messages", messagesJson(inputMessages)],
      ["gen_ai.output.messages", messagesJson(outputMessages)],
    );
  }

  const eventAttributes = attrs(eventPairs);
  if (place.event) {
    for (const [key, value] of [
      ["gen_ai.input.messages", inputMessages],
      ["gen_ai.output.messages", outputMessages],
    ] as const) {
      const item = structuredAttr(key, value);
      if (item !== null) {
        eventAttributes.push(item);
      }
    }
  }

  return {
    attributes: attrs(spanPairs),
    event:
      place.event && eventAttributes.length > 0
        ? {
            timeUnixNano: input.timeNs.toString(),
            name: INFERENCE_EVENT_NAME,
            attributes: eventAttributes,
          }
        : null,
  };
}

/** The provider the rollout reports, falling back to the runtime's default. */
export function providerName(state: HookState): string {
  return (
    state.rollout_context.model_provider ||
    (state.runtime === "claude" ? "anthropic" : "openai")
  );
}

/**
 * `gen_ai.agent.name`. The same value is used on span and metric attributes.
 *
 * semconv treats a subagent as a distinct agent with its own invocation, and defines
 * `gen_ai.agent.name` on `gen_ai.execute_tool.duration` as the name of the agent that ran
 * the tool. Claude Code's `agent_type` (`general-purpose` and friends) is exactly that
 * name, so spans originating from a subagent use agent_type rather than the runtime name.
 */
export function agentName(state: HookState, payload?: HookPayload): string {
  return payload?.agent_type || (state.runtime === "claude" ? "claude-code" : "codex");
}

export interface CommonOptions {
  /**
   * True for an invoke_agent span. On the semconv invoke_agent internal span,
   * `gen_ai.request.model` applies only when the agent is configured with a single model;
   * for agents with multiple or dynamically chosen models it is SHOULD NOT populate. A
   * coding agent can switch models mid-session, so the model observed during the turn is
   * reported as an extension attribute instead (the `gen_ai.invoke_agent.*` metrics omit
   * the model for the same reason).
   */
  agentSpan?: boolean;
}

/**
 * Identity and context attributes shared by the turn, LLM request, and tool call spans.
 *
 * Whenever the semconv registry defines an attribute, that one is used; custom attributes
 * are limited to **information the registry cannot express**. The ones kept here, and why:
 *
 *     {runtime}.turn.id             no gen_ai attribute identifies a single turn
 *                                   (invocation)
 *     {runtime}.turn.model          gen_ai.request.model is SHOULD NOT populate on an
 *                                   invoke_agent internal span (see CommonOptions above)
 *     {runtime}.cwd                 no gen_ai attribute for the working directory
 *     {runtime}.originator          no attribute for the calling UI (CLI, IDE, ...)
 *     {runtime}.permission_mode     no attribute for the permission mode
 *     claude.agent.id               gen_ai.agent.id is a stable, provider-issued agent
 *                                   resource ID; putting a transient in-process instance
 *                                   ID there is NOT RECOMMENDED
 */
export function commonAttrs(
  state: HookState,
  payload: HookPayload,
  model: string | null | undefined,
  options: CommonOptions = {},
): AttrPair[] {
  const context = state.rollout_context;
  const runtime = state.runtime;
  const pairs: AttrPair[] = [
    ["gen_ai.provider.name", providerName(state)],
    ["gen_ai.agent.name", agentName(state, payload)],
    // The CLI's own version is the agent version.
    ["gen_ai.agent.version", context.cli_version],
    ["gen_ai.conversation.id", state.session_id],
    // Keeps one turn per trace while letting a capable backend group them into one session.
    ["session.id", state.session_id],
    ...(options.agentSpan
      ? ([[`${runtime}.turn.model`, model]] as AttrPair[])
      : ([
          ["gen_ai.request.model", model],
          ["gen_ai.response.model", model],
        ] as AttrPair[])),
    [`${runtime}.cwd`, payload.cwd || state.cwd],
    [`${runtime}.originator`, context.originator],
    [`${runtime}.permission_mode`, payload.permission_mode],
  ];
  if (runtime === "claude") {
    pairs.push(["claude.agent.id", payload.agent_id]);
  }
  return pairs;
}

/**
 * Which kind of span the attributes go on. `agent` means the invoke_agent span.
 *
 * semconv explicitly removed `gen_ai.usage.cache_read.input_tokens` and
 * `gen_ai.usage.cache_write.input_tokens` from the invoke_agent internal span: a turn's
 * cache breakdown is a sum across several models and requests, which is misleading (the
 * breakdown should be aggregated from the child chat spans instead). Following that, the
 * cache-derived breakdown is left off the turn span.
 */
export type UsageScope = "inference" | "agent";

/** Tokens and cost, rounded to 8 decimal places before being attached. */
export function usageAttrs(
  usage: Usage,
  cost: CostBreakdown,
  runtime: AgentRuntime = "codex",
  scope: UsageScope = "inference",
): AttrPair[] {
  const round8 = (value: number): number => Math.round(value * 1e8) / 1e8;
  const cacheBreakdown: AttrPair[] =
    scope === "agent"
      ? []
      : [
          ["gen_ai.usage.cache_read.input_tokens", usage.cached_input_tokens],
          ["gen_ai.usage.cache_write.input_tokens", usage.cache_creation_input_tokens],
          // The per-TTL ephemeral breakdown is Anthropic-specific and absent from semconv.
          [`${runtime}.usage.cache_write.5m.input_tokens`, usage.cache_creation_5m_input_tokens],
          [`${runtime}.usage.cache_write.1h.input_tokens`, usage.cache_creation_1h_input_tokens],
          [`${runtime}.usage.uncached_input_tokens`, cost.uncachedInputTokens],
        ];
  return [
    // input_tokens counts the whole prompt — system prompt, conversation history, and this
    // user prompt — including the cache read and write portions.
    ["gen_ai.usage.input_tokens", usage.input_tokens],
    ["gen_ai.usage.output_tokens", usage.output_tokens],
    ["gen_ai.usage.reasoning.output_tokens", usage.reasoning_output_tokens],
    ...cacheBreakdown,
    // Everything below is an extension absent from the semconv registry. `gen_ai.*` is
    // OTel's namespace, so custom attributes live under the runtime's own prefix.
    [`${runtime}.usage.total_tokens`, usage.total_tokens],
    [`${runtime}.usage.cost`, double(round8(cost.totalCost))],
    [`${runtime}.usage.input_cost`, double(round8(cost.inputCost))],
    [`${runtime}.usage.output_cost`, double(round8(cost.outputCost))],
    [`${runtime}.usage.cost.currency`, cost.currency],
    [`${runtime}.usage.cost.pricing_matched`, cost.pricingMatched],
  ];
}
function contentMaximum(): number {
  const raw = env(["CAT_OTEL_CONTENT_MAX_CHARS"]);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(2, parsed) : 20000;
}
