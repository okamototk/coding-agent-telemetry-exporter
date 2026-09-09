/**
 * GenAI semconv metrics — recording measurements, then building and sending OTLP metrics.
 *
 * The semconv histograms are built from the same observations as the spans. The hook runs
 * as one process per event and carries no state across them, so only what that event
 * observed is sent, with **Delta** temporality (cumulative is impossible without keeping
 * the previous value).
 *
 * Attributes are limited to those semconv defines for each metric. High-cardinality
 * identifiers such as session.id and turn.id stay on the spans only; putting them on
 * metrics would explode the time series beyond what a backend can hold.
 *
 * The metrics emitted:
 *
 *     gen_ai.client.token.usage           two points per chat span: input and output
 *     gen_ai.client.operation.duration    chat span duration
 *     gen_ai.invoke_agent.duration        turn span duration
 *     gen_ai.invoke_agent.inference_calls LLM requests in that turn
 *     gen_ai.invoke_agent.tool_calls      tool calls in that turn
 *     gen_ai.execute_tool.duration        execute_tool span duration
 *
 * The rest of semconv cannot be produced in principle: the rollout has no per-chunk
 * timestamps for time_to_first_chunk / time_per_output_chunk, gen_ai.server.* is measured
 * server-side, and the CLI has no concept matching gen_ai.invoke_workflow.duration. Cost
 * has no semconv metric, so it remains an extension on the span attributes.
 */

import { metricsUrl } from "./env.ts";
import {
  attrs,
  postOtlp,
  resourceAttributes,
  SCOPE_NAME,
  SCOPE_VERSION,
  type Attr,
  type AttrValue,
} from "./otlp.ts";

type MetricPair = readonly [string, AttrValue];

/** AGGREGATION_TEMPORALITY_DELTA */
const DELTA = 1;

interface Instrument {
  name: string;
  unit: string;
  description: string;
  /** The ExplicitBucketBoundaries semconv lists as SHOULD. */
  bounds: readonly number[];
}

/** Boundaries in seconds, for LLM calls and tool executions. */
const SECONDS_BOUNDS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
] as const;

/** One agent turn outlasts one LLM call, so the boundaries are coarser. */
const AGENT_SECONDS_BOUNDS = [
  0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
] as const;

/** Boundaries for counts (inference_calls / tool_calls). */
const CALL_BOUNDS = [1, 2, 4, 8, 16, 32, 64, 128] as const;

const TOKEN_USAGE: Instrument = {
  name: "gen_ai.client.token.usage",
  unit: "{token}",
  description: "Number of input and output tokens used.",
  bounds: [
    1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
  ],
};

const OPERATION_DURATION: Instrument = {
  name: "gen_ai.client.operation.duration",
  unit: "s",
  description: "GenAI operation duration.",
  bounds: SECONDS_BOUNDS,
};

const AGENT_DURATION: Instrument = {
  name: "gen_ai.invoke_agent.duration",
  unit: "s",
  description:
    "The end-to-end duration of a single in-process agent invocation, from the moment the " +
    "invocation starts until the agent emits the last chunk of its final response or " +
    "terminates with an error.",
  bounds: AGENT_SECONDS_BOUNDS,
};

const AGENT_INFERENCE_CALLS: Instrument = {
  name: "gen_ai.invoke_agent.inference_calls",
  unit: "{inference_call}",
  description: "The number of inference (model) calls a GenAI agent makes during a single invocation.",
  bounds: CALL_BOUNDS,
};

const AGENT_TOOL_CALLS: Instrument = {
  name: "gen_ai.invoke_agent.tool_calls",
  unit: "{tool_call}",
  description: "The number of tool calls a GenAI agent makes during a single invocation.",
  bounds: CALL_BOUNDS,
};

const TOOL_DURATION: Instrument = {
  name: "gen_ai.execute_tool.duration",
  unit: "s",
  description: "The duration of a single tool execution.",
  bounds: SECONDS_BOUNDS,
};

/** The well-known fallback value for error.type. */
export const ERROR_TYPE_OTHER = "_OTHER";

interface Point {
  instrument: Instrument;
  attributes: Attr[];
  count: number;
  sum: number;
  minimum: number;
  maximum: number;
  buckets: number[];
  startNs: bigint;
  endNs: bigint;
}

/** Holds the measurements accumulated for one hook event. */
export interface MetricStore {
  points: Map<string, Point>;
}

export function newMetricStore(): MetricStore {
  return { points: new Map() };
}

/** The bucket a value falls into. OTLP boundaries are inclusive: (bounds[i-1], bounds[i]]. */
function bucketIndex(bounds: readonly number[], value: number): number {
  for (let index = 0; index < bounds.length; index += 1) {
    if (value <= (bounds[index] ?? Number.POSITIVE_INFINITY)) {
      return index;
    }
  }
  return bounds.length;
}

/** Adds one measurement to the data point sharing the same attributes. */
function record(
  store: MetricStore,
  instrument: Instrument,
  value: number,
  pairs: readonly MetricPair[],
  startNs: bigint,
  endNs: bigint,
): void {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  const attributes = attrs(pairs);
  const key = `${instrument.name} ${attributes
    .map((item) => `${item.key}=${Object.values(item.value)[0] as string}`)
    .join(",")}`;
  let point = store.points.get(key);
  if (!point) {
    point = {
      instrument,
      attributes,
      count: 0,
      sum: 0,
      minimum: value,
      maximum: value,
      buckets: Array.from({ length: instrument.bounds.length + 1 }, () => 0),
      startNs,
      endNs,
    };
    store.points.set(key, point);
  }
  point.count += 1;
  point.sum += value;
  point.minimum = Math.min(point.minimum, value);
  point.maximum = Math.max(point.maximum, value);
  const index = bucketIndex(instrument.bounds, value);
  point.buckets[index] = (point.buckets[index] ?? 0) + 1;
  if (startNs < point.startNs) {
    point.startNs = startNs;
  }
  if (endNs > point.endNs) {
    point.endNs = endNs;
  }
}

function durationSeconds(startNs: bigint, endNs: bigint): number {
  const span = endNs > startNs ? endNs - startNs : 0n;
  return Number(span) / 1e9;
}

/** Measurements for one LLM request (one chat span). */
export interface ChatMeasurement {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  startNs: bigint;
  endNs: bigint;
}

export function recordChat(store: MetricStore, chat: ChatMeasurement): void {
  const common: MetricPair[] = [
    ["gen_ai.operation.name", "chat"],
    ["gen_ai.provider.name", chat.provider],
    ["gen_ai.request.model", chat.model],
    ["gen_ai.response.model", chat.model],
  ];
  for (const [type, tokens] of [
    ["input", chat.inputTokens],
    ["output", chat.outputTokens],
  ] as const) {
    record(
      store,
      TOKEN_USAGE,
      tokens,
      [...common, ["gen_ai.token.type", type]],
      chat.startNs,
      chat.endNs,
    );
  }
  record(
    store,
    OPERATION_DURATION,
    durationSeconds(chat.startNs, chat.endNs),
    common,
    chat.startNs,
    chat.endNs,
  );
}

/** Measurements for one turn (one invoke_agent span). */
export interface TurnMeasurement {
  agent: string;
  inferenceCalls: number;
  toolCalls: number;
  errorType: string | null;
  startNs: bigint;
  endNs: bigint;
}

export function recordTurn(store: MetricStore, turn: TurnMeasurement): void {
  const agent: MetricPair[] = [["gen_ai.agent.name", turn.agent]];
  // gen_ai.request.model belongs here only when the agent is configured with a single
  // model. A coding agent can switch models mid-session, so it is left off.
  record(
    store,
    AGENT_DURATION,
    durationSeconds(turn.startNs, turn.endNs),
    [...agent, ["error.type", turn.errorType]],
    turn.startNs,
    turn.endNs,
  );
  record(store, AGENT_INFERENCE_CALLS, turn.inferenceCalls, agent, turn.startNs, turn.endNs);
  record(store, AGENT_TOOL_CALLS, turn.toolCalls, agent, turn.startNs, turn.endNs);
}

/** Measurements for one tool execution (one execute_tool span). */
export interface ToolMeasurement {
  agent: string;
  name: string;
  type: string;
  errorType: string | null;
  startNs: bigint;
  endNs: bigint;
}

export function recordTool(store: MetricStore, tool: ToolMeasurement): void {
  record(
    store,
    TOOL_DURATION,
    durationSeconds(tool.startNs, tool.endNs),
    [
      ["gen_ai.tool.name", tool.name],
      ["gen_ai.tool.type", tool.type],
      ["gen_ai.agent.name", tool.agent],
      ["error.type", tool.errorType],
    ],
    tool.startNs,
    tool.endNs,
  );
}

interface OtlpHistogramPoint {
  startTimeUnixNano: string;
  timeUnixNano: string;
  /** uint64 is a string in proto3 JSON. */
  count: string;
  sum: number;
  min: number;
  max: number;
  bucketCounts: string[];
  explicitBounds: number[];
  attributes: Attr[];
}

export interface OtlpMetric {
  name: string;
  unit: string;
  description: string;
  histogram: {
    aggregationTemporality: number;
    dataPoints: OtlpHistogramPoint[];
  };
}

/** Turns the accumulated measurements into an OTLP metrics array. */
export function metricPayload(store: MetricStore): OtlpMetric[] {
  const byName = new Map<string, OtlpMetric>();
  for (const point of store.points.values()) {
    let metric = byName.get(point.instrument.name);
    if (!metric) {
      metric = {
        name: point.instrument.name,
        unit: point.instrument.unit,
        description: point.instrument.description,
        histogram: { aggregationTemporality: DELTA, dataPoints: [] },
      };
      byName.set(point.instrument.name, metric);
    }
    metric.histogram.dataPoints.push({
      startTimeUnixNano: point.startNs.toString(),
      timeUnixNano: point.endNs.toString(),
      count: String(point.count),
      sum: point.sum,
      min: point.minimum,
      max: point.maximum,
      bucketCounts: point.buckets.map(String),
      explicitBounds: [...point.instrument.bounds],
      attributes: point.attributes,
    });
  }
  return [...byName.values()];
}

/** Builds an ExportMetricsServiceRequest and sends it. Fail-open, like the spans. */
export function exportMetrics(store: MetricStore, serviceName: string): Promise<void> {
  const metrics = metricPayload(store);
  if (metrics.length === 0) {
    return Promise.resolve();
  }
  return postOtlp(
    metricsUrl(),
    {
      resourceMetrics: [
        {
          resource: { attributes: resourceAttributes(serviceName) },
          scopeMetrics: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, metrics }],
        },
      ],
    },
    `metrics=${metrics.length}`,
  );
}
