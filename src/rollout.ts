/**
 * Reads the rollout JSONL.
 *
 * The Codex hook payload carries no token usage, so usage is taken from the `event_msg` /
 * `token_count` records of the rollout Codex writes itself (`transcript_path`).
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { codexHome } from "./env.ts";
import { isoToNs } from "./time.ts";
import { usageOf } from "./state.ts";
import {
  mapUsage,
  type GenAiMessage,
  type HookPayload,
  type HookState,
  type RolloutContext,
  type RolloutRequest,
  type RolloutToolCall,
  type Usage,
  USAGE_KEYS,
} from "./types.ts";

/** Returns the first `*-<session_id>.jsonl` found. The walk is shallow: year/month/day. */
function findRollout(root: string, suffix: string): string | null {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories.push(join(root, entry.name));
    } else if (entry.name.endsWith(suffix)) {
      return join(root, entry.name);
    }
  }
  for (const directory of directories) {
    const found = findRollout(directory, suffix);
    if (found) {
      return found;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Prefers transcript_path; when it is null, searches for the rollout by session_id. */
export function resolveRollout(payload: HookPayload, state: HookState): string | null {
  const path = payload.transcript_path || state.rollout_path;
  if (path && isFile(path)) {
    return path;
  }
  const sessionId = payload.session_id || "";
  if (!sessionId) {
    return null;
  }
  const root = process.env["CODEX_SESSIONS_DIR"] || join(codexHome(), "sessions");
  // Filenames look like rollout-<ISO8601>-<session_id>.jsonl.
  return findRollout(root, `-${sessionId}.jsonl`);
}

export interface DrainResult {
  requests: RolloutRequest[];
  tools: RolloutToolCall[];
  /** Byte position up to which complete lines were consumed. */
  offset: number;
  context: RolloutContext;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function contentParts(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const part = item as Record<string, unknown>;
    const text = asString(part["text"]);
    if (text) {
      parts.push({ type: "text", content: text });
    }
  }
  return parts;
}

/** Maps a response_item to a GenAI message. Encrypted reasoning content is never emitted. */
function responseMessage(body: Record<string, unknown>): GenAiMessage | null {
  const type = body["type"];
  if (type === "message") {
    const role = asString(body["role"]);
    const parts = contentParts(body["content"]);
    return role && parts.length > 0 ? { role, parts } : null;
  }
  if (type === "function_call" || type === "custom_tool_call") {
    return {
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: asString(body["call_id"]) ?? asString(body["id"]) ?? "",
          name: asString(body["name"]) ?? "",
          arguments: asString(body["arguments"]) ?? asString(body["input"]) ?? "",
        },
      ],
    };
  }
  if (type === "function_call_output") {
    return {
      role: "tool",
      parts: [
        {
          type: "tool_call_response",
          id: asString(body["call_id"]) ?? "",
          content: asString(body["output"]) ?? "",
        },
      ],
    };
  }
  if (type === "web_search_call") {
    return {
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: asString(body["id"]) ?? "",
          name: "web_search",
          arguments: body["action"] === undefined ? "" : JSON.stringify(body["action"]),
        },
      ],
    };
  }
  return null;
}

function isModelOutput(body: Record<string, unknown>): boolean {
  const type = body["type"];
  return (
    (type === "message" && body["role"] === "assistant") ||
    type === "reasoning" ||
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "web_search_call"
  );
}

function turnIdOf(body: Record<string, unknown>, fallback: string | null): string | null {
  const metadata = body["internal_chat_message_metadata_passthrough"];
  const metadataTurn =
    metadata && typeof metadata === "object"
      ? asString((metadata as Record<string, unknown>)["turn_id"])
      : null;
  return asString(body["turn_id"]) ?? metadataTurn ?? fallback;
}

function toolError(result: string | null): string | null {
  if (!result) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const metadata = record["metadata"];
      if (metadata && typeof metadata === "object") {
        const exitCode = (metadata as Record<string, unknown>)["exit_code"];
        if (typeof exitCode === "number" && exitCode !== 0) {
          return `tool exited with code ${exitCode}`;
        }
      }
    }
  } catch {
    // Plain text output is classified by the patterns below.
  }
  const exit = /Process exited with code (\d+)/.exec(result) ?? /Exit code: (\d+)/.exec(result);
  if (exit?.[1] && exit[1] !== "0") {
    return `tool exited with code ${exit[1]}`;
  }
  if (/^(execution error|tool error|error:)/i.test(result.trim())) {
    return result.trim().slice(0, 500);
  }
  return null;
}

/**
 * Reads the unread portion and returns normalized token_count records and tool calls.
 *
 * The rollout is still being appended to, so a trailing incomplete line is left for the
 * next run: only bytes up to the last newline are consumed.
 */
export function drainRollout(path: string, offset: number, captureMessages = false): DrainResult {
  const requests: RolloutRequest[] = [];
  const tools: RolloutToolCall[] = [];
  const context: RolloutContext = {};
  const pendingTools = new Map<
    string,
    {
      callId: string;
      name: string;
      turnId: string | null;
      startNs: bigint;
      arguments: string | null;
    }
  >();

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { requests, tools, offset, context };
  }
  if (offset > size) {
    offset = 0; // The rollout was replaced (resume / clear).
  }
  if (offset === size) {
    return { requests, tools, offset, context };
  }

  // Reconstructing message history requires reading from the start. Requests and tools are
  // still only emitted past the previous offset, so no span is ever duplicated.
  const previousOffset = offset;
  const readStart = captureMessages ? 0 : offset;
  const buffer = Buffer.allocUnsafe(size - readStart);
  let read = 0;
  const handle = openSync(path, "r");
  try {
    read = readSync(handle, buffer, 0, buffer.length, readStart);
  } finally {
    closeSync(handle);
  }

  // 0x0A never appears inside a UTF-8 multi-byte sequence, so a byte-wise newline scan is safe.
  const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
  if (lastNewline < 0) {
    return { requests, tools, offset, context }; // Not one complete line yet.
  }
  const consumed = readStart + lastNewline + 1;

  let turnId: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  const messageHistory: GenAiMessage[] = [];
  let callInput: GenAiMessage[] | null = null;
  let callOutput: GenAiMessage[] = [];

  let lineStart = 0;
  while (lineStart < lastNewline) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline < 0 || newline > lastNewline) {
      break;
    }
    const lineEnd = readStart + newline + 1;
    const active = lineEnd > previousOffset;
    const text = buffer.subarray(lineStart, newline).toString("utf8").trim();
    lineStart = newline + 1;
    if (!text) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") {
      continue;
    }

    const entry = record as Record<string, unknown>;
    const kind = entry["type"];
    const raw = entry["payload"];
    const body: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

    if (kind === "session_meta") {
      context.cli_version = asString(body["cli_version"]);
      context.originator = asString(body["originator"]);
      context.model_provider = asString(body["model_provider"]);
      context.source = asString(body["source"]);
      context.session_started_ns =
        isoToNs(body["timestamp"] ?? entry["timestamp"])?.toString() ?? null;
      if (captureMessages) {
        const instructions = asString(body["base_instructions"]);
        if (instructions) {
          messageHistory.push({
            role: "system",
            parts: [{ type: "text", content: instructions }],
          });
        }
      }
      continue;
    }

    if (kind === "turn_context") {
      turnId = asString(body["turn_id"]) ?? turnId;
      model = asString(body["model"]) ?? model;
      effort = asString(body["effort"]) ?? effort;
      context.model = model;
      context.effort = effort;
      continue;
    }

    if (kind === "response_item") {
      const itemType = body["type"];
      const timestamp = isoToNs(entry["timestamp"]);
      if (captureMessages) {
        const generated = isModelOutput(body);
        const normalized = responseMessage(body);
        if (generated && callInput === null) {
          callInput = structuredClone(messageHistory);
        }
        if (normalized) {
          messageHistory.push(normalized);
          if (generated) {
            callOutput.push(normalized);
          }
        }
      }
      if (itemType === "function_call") {
        const callId = asString(body["call_id"]);
        const name = asString(body["name"]);
        if (callId && name && timestamp !== null) {
          pendingTools.set(callId, {
            callId,
            name,
            turnId: turnIdOf(body, turnId),
            startNs: timestamp,
            arguments: asString(body["arguments"]),
          });
        }
      } else if (itemType === "function_call_output") {
        const callId = asString(body["call_id"]);
        const pending = callId ? pendingTools.get(callId) : undefined;
        if (pending && timestamp !== null) {
          const result = asString(body["output"]);
          if (active) {
            tools.push({
              ...pending,
              endNs: timestamp,
              result,
              error: toolError(result),
            });
          }
          pendingTools.delete(pending.callId);
        }
      } else if (itemType === "custom_tool_call" && body["status"] === "completed") {
        const callId = asString(body["call_id"]);
        const name = asString(body["name"]);
        if (callId && name && timestamp !== null) {
          if (active) {
            tools.push({
              callId,
              name,
              turnId: turnIdOf(body, turnId),
              startNs: timestamp,
              endNs: timestamp,
              arguments: asString(body["input"]),
              result: null,
              error: null,
            });
          }
        }
      } else if (itemType === "web_search_call" && body["status"] === "completed") {
        const callId = asString(body["id"]);
        if (callId && timestamp !== null) {
          if (active) {
            tools.push({
              callId,
              name: "web_search",
              turnId: turnIdOf(body, turnId),
              startNs: timestamp,
              endNs: timestamp,
              arguments: body["action"] === undefined ? null : JSON.stringify(body["action"]),
              result: null,
              error: null,
            });
          }
        }
      }
      continue;
    }

    if (kind !== "event_msg") {
      continue;
    }

    const event = body["type"];
    if (event === "task_started") {
      turnId = asString(body["turn_id"]) ?? turnId;
      continue;
    }
    if (event === "task_complete") {
      turnId = asString(body["turn_id"]) ?? turnId;
      const error = body["error"];
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>)["message"];
        if (message) {
          (context.errors ??= []).push(String(message).slice(0, 500));
        }
      }
      continue;
    }
    if (event !== "token_count") {
      continue;
    }

    const info = body["info"];
    if (!info || typeof info !== "object") {
      // `info: null` just signals "no usage yet" and can be ignored.
      continue;
    }
    const usage = info as Record<string, unknown>;
    const contextWindow = usage["model_context_window"];
    if (active) {
      requests.push({
        endNs: isoToNs(entry["timestamp"]),
        turnId: asString(body["turn_id"]) ?? turnId,
        model: asString(body["model"]) ?? model,
        effort,
        contextWindow: typeof contextWindow === "number" ? contextWindow : null,
        inputMessages: captureMessages
          ? structuredClone(callInput ?? messageHistory)
          : [],
        outputMessages: captureMessages ? structuredClone(callOutput) : [],
        last: usageOf(usage["last_token_usage"]),
        total: usageOf(usage["total_token_usage"]),
      });
    }
    callInput = null;
    callOutput = [];
  }

  return { requests, tools, offset: consumed, context };
}

export interface PerRequestUsage {
  usage: Usage;
  cumulative: Usage;
}

/**
 * Returns the usage for one request plus the updated cumulative total, or null for a
 * duplicate record.
 *
 * Usage is derived from the delta of the monotonically increasing total_token_usage.
 * last_token_usage must not be used directly: Codex sometimes writes the same token_count
 * twice (measured: 299 of 598 records repeated the previous total), and summing `last`
 * would inflate the result exactly twofold. With deltas a duplicate comes out as zero and
 * is dropped. `last` is only a fallback for when total_token_usage is absent or all zeros.
 */
export function perRequestUsage(request: RolloutRequest, cumulative: Usage): PerRequestUsage | null {
  const total = request.total;
  const last = request.last;
  let usage: Usage;
  let updated: Usage;

  if (USAGE_KEYS.some((key) => total[key])) {
    if (total.total_tokens < cumulative.total_tokens) {
      // The cumulative total was reset (e.g. by /clear). Use the total as-is, not a delta.
      usage = { ...total };
    } else {
      usage = mapUsage((key) => Math.max(0, total[key] - cumulative[key]));
    }
    if (!usage.input_tokens && !usage.output_tokens && !usage.total_tokens) {
      return null; // The same total repeated; do not count it as a request.
    }
    updated = { ...total };
  } else if (last.input_tokens || last.output_tokens || last.total_tokens) {
    usage = { ...last };
    updated = mapUsage((key) => cumulative[key] + last[key]);
  } else {
    return null;
  }

  if (!usage.total_tokens) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  return { usage, cumulative: updated };
}

export function addUsage(into: Usage, usage: Usage): Usage {
  return mapUsage((key) => into[key] + usage[key]);
}
