/**
 * Reads the Claude Code transcript JSONL.
 *
 * A single assistant API response is split across multiple lines — one per thinking / text /
 * tool_use block — and every line repeats the same message.id and usage. Lines are grouped
 * by message.id so that usage is emitted exactly once.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

import { usageOf } from "./state.ts";
import { isoToNs } from "./time.ts";
import {
  type GenAiMessage,
  type HookState,
  type PendingToolState,
  type RolloutRequest,
  type RolloutToolCall,
  type TranscriptCursor,
  type Usage,
} from "./types.ts";
import type { DrainResult } from "./rollout.ts";

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function cursorOf(state: HookState, path: string): TranscriptCursor {
  const saved = state.transcript_cursors[path];
  if (saved) {
    saved.offset = Number.isFinite(saved.offset) ? Math.max(0, Math.trunc(saved.offset)) : 0;
    saved.seen_request_ids = Array.isArray(saved.seen_request_ids) ? saved.seen_request_ids : [];
    saved.seen_tool_ids = Array.isArray(saved.seen_tool_ids) ? saved.seen_tool_ids : [];
    saved.pending_tools =
      saved.pending_tools && typeof saved.pending_tools === "object" ? saved.pending_tools : {};
    return saved;
  }
  const cursor: TranscriptCursor = {
    offset: 0,
    seen_request_ids: [],
    seen_tool_ids: [],
    pending_tools: {},
  };
  state.transcript_cursors[path] = cursor;
  return cursor;
}

function usageFromClaude(raw: unknown): Usage {
  if (!raw || typeof raw !== "object") {
    return usageOf(null);
  }
  const source = raw as Record<string, unknown>;
  const creation = Math.max(0, asInt(source["cache_creation_input_tokens"]));
  const cache = source["cache_creation"];
  const cacheRecord =
    cache && typeof cache === "object" ? (cache as Record<string, unknown>) : {};
  const creation5m = asInt(cacheRecord["ephemeral_5m_input_tokens"]);
  const creation1h = asInt(cacheRecord["ephemeral_1h_input_tokens"]);
  const cacheRead = asInt(source["cache_read_input_tokens"]);
  const baseInput = asInt(source["input_tokens"]);
  const output = asInt(source["output_tokens"]);
  const outputDetails = source["output_tokens_details"];
  const details =
    outputDetails && typeof outputDetails === "object"
      ? (outputDetails as Record<string, unknown>)
      : {};
  return {
    input_tokens: baseInput + cacheRead + creation,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: creation,
    cache_creation_5m_input_tokens: creation5m,
    cache_creation_1h_input_tokens: creation1h,
    output_tokens: output,
    reasoning_output_tokens: asInt(details["thinking_tokens"]),
    total_tokens: baseInput + cacheRead + creation + output,
  };
}

function encoded(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function blocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message["content"];
  if (Array.isArray(content)) {
    return content.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  }
  if (typeof content === "string" && content) {
    return [{ type: "text", text: content }];
  }
  return [];
}

function normalizedParts(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const type = block["type"];
    if (type === "text") {
      const content = asString(block["text"]);
      if (content) {
        parts.push({ type: "text", content });
      }
    } else if (type === "thinking") {
      const content = asString(block["thinking"]);
      if (content) {
        parts.push({ type: "reasoning", content });
      }
    } else if (type === "tool_use") {
      parts.push({
        type: "tool_call",
        id: asString(block["id"]),
        name: asString(block["name"]),
        arguments: encoded(block["input"]) ?? "",
      });
    } else if (type === "tool_result") {
      parts.push({
        type: "tool_call_response",
        id: asString(block["tool_use_id"]),
        response: encoded(block["content"]) ?? "",
      });
    }
  }
  return parts;
}

interface RequestGroup {
  id: string;
  endNs: bigint | null;
  turnId: string | null;
  model: string | null;
  effort: string | null;
  usage: Usage;
  inputMessages: GenAiMessage[];
  outputParts: Record<string, unknown>[];
}

function pendingFrom(block: Record<string, unknown>, turnId: string | null, timestamp: bigint): PendingToolState | null {
  const callId = asString(block["id"]);
  const name = asString(block["name"]);
  if (!callId || !name) {
    return null;
  }
  return {
    callId,
    name,
    turnId,
    start_ns: timestamp.toString(),
    arguments: encoded(block["input"]),
  };
}

export function drainClaudeTranscript(
  path: string,
  state: HookState,
  captureMessages: boolean,
  fallbackTurn: string,
): DrainResult {
  const requests: RolloutRequest[] = [];
  const tools: RolloutToolCall[] = [];
  const context = {};
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { requests, tools, offset: 0, context };
  }

  const cursor = cursorOf(state, path);
  if (size < cursor.offset) {
    cursor.offset = 0;
    cursor.seen_request_ids = [];
    cursor.seen_tool_ids = [];
    cursor.pending_tools = {};
  }
  if (size === cursor.offset) {
    return { requests, tools, offset: cursor.offset, context };
  }

  const previousOffset = cursor.offset;
  const readStart = captureMessages ? 0 : previousOffset;
  const buffer = Buffer.allocUnsafe(size - readStart);
  const handle = openSync(path, "r");
  let read = 0;
  try {
    read = readSync(handle, buffer, 0, buffer.length, readStart);
  } finally {
    closeSync(handle);
  }
  const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
  if (lastNewline < 0) {
    return { requests, tools, offset: cursor.offset, context };
  }
  const consumed = readStart + lastNewline + 1;
  const seenRequests = new Set(cursor.seen_request_ids);
  const seenTools = new Set(cursor.seen_tool_ids);
  const groups = new Map<string, RequestGroup>();
  const history: GenAiMessage[] = [];

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
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const entry = record as Record<string, unknown>;
    const messageRaw = entry["message"];
    const message =
      messageRaw && typeof messageRaw === "object" && !Array.isArray(messageRaw)
        ? (messageRaw as Record<string, unknown>)
        : null;
    if (!message) {
      continue;
    }
    const role = asString(message["role"]);
    const blocks = blocksOf(message);
    const parts = normalizedParts(blocks);
    const promptId = asString(entry["promptId"]) ?? fallbackTurn;
    const timestamp = isoToNs(entry["timestamp"]);

    if (role === "assistant") {
      const requestId = asString(message["id"]) ?? asString(entry["uuid"]);
      if (requestId && active && !seenRequests.has(requestId)) {
        let group = groups.get(requestId);
        if (!group) {
          group = {
            id: requestId,
            endNs: timestamp,
            turnId: promptId,
            model: asString(message["model"]),
            effort: asString(entry["effort"]),
            usage: usageFromClaude(message["usage"]),
            inputMessages: captureMessages ? structuredClone(history) : [],
            outputParts: [],
          };
          groups.set(requestId, group);
        }
        group.endNs =
          timestamp !== null && (group.endNs === null || timestamp > group.endNs)
            ? timestamp
            : group.endNs;
        group.outputParts.push(...parts);
      }
      if (timestamp !== null) {
        for (const block of blocks) {
          if (block["type"] !== "tool_use") {
            continue;
          }
          const pending = pendingFrom(block, promptId, timestamp);
          if (pending && !seenTools.has(pending.callId)) {
            cursor.pending_tools[pending.callId] = pending;
          }
        }
      }
      if (captureMessages && parts.length > 0) {
        history.push({ role: "assistant", parts });
      }
      continue;
    }

    if (role !== "user") {
      continue;
    }
    for (const block of blocks) {
      if (block["type"] !== "tool_result") {
        continue;
      }
      const callId = asString(block["tool_use_id"]);
      const pending = callId ? cursor.pending_tools[callId] : undefined;
      if (!callId || !pending || timestamp === null || seenTools.has(callId) || !active) {
        continue;
      }
      const result = encoded(block["content"]);
      tools.push({
        callId,
        name: pending.name,
        turnId: pending.turnId ?? promptId,
        startNs: BigInt(pending.start_ns),
        endNs: timestamp,
        arguments: pending.arguments,
        result,
        error: block["is_error"] === true ? result || "tool failed" : null,
      });
      seenTools.add(callId);
      delete cursor.pending_tools[callId];
    }
    if (captureMessages && parts.length > 0) {
      const toolOnly = blocks.every((block) => block["type"] === "tool_result");
      history.push({ role: toolOnly ? "tool" : "user", parts });
    }
  }

  for (const group of groups.values()) {
    requests.push({
      endNs: group.endNs,
      turnId: group.turnId,
      model: group.model,
      effort: group.effort,
      contextWindow: null,
      inputMessages: group.inputMessages,
      outputMessages:
        captureMessages && group.outputParts.length > 0
          ? [{ role: "assistant", parts: group.outputParts }]
          : [],
      last: group.usage,
      total: usageOf(null),
    });
    seenRequests.add(group.id);
  }

  cursor.offset = consumed;
  cursor.seen_request_ids = [...seenRequests];
  cursor.seen_tool_ids = [...seenTools];
  return { requests, tools, offset: consumed, context };
}
