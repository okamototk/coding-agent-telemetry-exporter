/** Shapes of the coding agent hook payload, transcripts, and state file. */

export type AgentRuntime = "codex" | "claude";

/** The events this hook subscribes to. */
export type HookEventName = "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd";

/**
 * The JSON the agent passes on stdin. The agent owns the schema, so only the fields this
 * hook reads are declared, and loosely: a missing field must not break anything.
 */
export interface HookPayload {
  hook_event_name?: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  /** Claude Code 2.1.196+. Shared by every event belonging to the same user prompt. */
  prompt_id?: string | null;
  cwd?: string | null;
  model?: string | null;
  permission_mode?: string | null;
  transcript_path?: string | null;
  /** UserPromptSubmit */
  prompt?: string | null;
  /** Stop */
  last_assistant_message?: string | null;
  stop_hook_active?: boolean | null;
  /** SessionStart: startup | resume | clear */
  source?: string | null;
  /** SessionEnd */
  reason?: string | null;
  /** Claude Code SubagentStop */
  agent_id?: string | null;
  agent_type?: string | null;
  agent_transcript_path?: string | null;
}

export const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation_5m_input_tokens",
  "cache_creation_1h_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

export type UsageKey = (typeof USAGE_KEYS)[number];
export type Usage = Record<UsageKey, number>;

/** The OTel GenAI message shape. Serialized to a JSON string when set as an attribute. */
export interface GenAiMessage {
  role: string;
  parts: Record<string, unknown>[];
}

export function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

export function mapUsage(pick: (key: UsageKey) => number): Usage {
  const out = emptyUsage();
  for (const key of USAGE_KEYS) {
    out[key] = pick(key);
  }
  return out;
}

/** One token_count record in the rollout = one LLM request. */
export interface RolloutRequest {
  endNs: bigint | null;
  turnId: string | null;
  model: string | null;
  effort: string | null;
  contextWindow: number | null;
  /** Message history passed to this LLM call, as far as the rollout can reconstruct it. */
  inputMessages: GenAiMessage[];
  /** The assistant message / tool calls this LLM call produced. */
  outputMessages: GenAiMessage[];
  /** last_token_usage (the most recent request). */
  last: Usage;
  /** total_token_usage (cumulative for the session). */
  total: Usage;
}

/** One function_call / function_call_output pair from the rollout. */
export interface RolloutToolCall {
  callId: string;
  name: string;
  turnId: string | null;
  startNs: bigint;
  endNs: bigint;
  arguments: string | null;
  result: string | null;
  error: string | null;
}

/** Session context picked up from the rollout and carried over in the state file. */
export interface RolloutContext {
  cli_version?: string | null;
  originator?: string | null;
  model_provider?: string | null;
  source?: string | null;
  /** Nanoseconds as a decimal string; a JSON number lacks the precision. */
  session_started_ns?: string | null;
  model?: string | null;
  effort?: string | null;
  errors?: string[];
}

export interface TurnState {
  /** Nanoseconds as a decimal string. */
  start_ns?: string;
  model?: string | null;
  prompt?: string | null;
  /** Whether the turn span was already sent; guards against re-sending a deterministic span ID. */
  emitted?: boolean;
}

export interface HookState {
  runtime: AgentRuntime;
  session_id: string;
  /** Nanoseconds as a decimal string. */
  started_at_ns: string;
  rollout_path: string | null;
  rollout_offset: number;
  llm_seq: number;
  /**
   * The last total_token_usage seen in the rollout. Serves as the baseline for the delta
   * calculation used when last_token_usage is not trustworthy.
   */
  cumulative: Usage;
  session_totals: Usage;
  session_cost: number;
  request_count: number;
  turns: Record<string, TurnState>;
  last_turn_id: string | null;
  last_event_ns: string | null;
  rollout_context: RolloutContext;
  /** Claude uses a separate transcript file per main / subagent, so progress is tracked per path. */
  transcript_cursors: Record<string, TranscriptCursor>;
  /** Totals collected early at SubagentStop, merged into the parent Stop's turn span. */
  pending_turns: Record<string, SerializedTurnBucket>;
  cwd?: string | null;
  model?: string | null;
  source?: string | null;
}

export interface PendingToolState {
  callId: string;
  name: string;
  turnId: string | null;
  start_ns: string;
  arguments: string | null;
}

export interface TranscriptCursor {
  offset: number;
  seen_request_ids: string[];
  seen_tool_ids: string[];
  pending_tools: Record<string, PendingToolState>;
}

export interface SerializedTurnBucket {
  usage: Usage;
  cost: number;
  count: number;
  toolCount: number;
  model: string | null;
  end_ns: string | null;
}

/** Per-turn totals, bundling the results of advancing through the rollout. */
export interface TurnBucket {
  usage: Usage;
  cost: number;
  count: number;
  toolCount: number;
  model: string | null;
  endNs: bigint | null;
}
