/**
 * Derives trace and span IDs deterministically from identifiers. The hook runs as a
 * separate process per event, but this still groups one turn into one trace: the same
 * identifier always yields the same ID.
 */

import { createHash } from "node:crypto";
import type { AgentRuntime } from "./types.ts";

function hexId(runtime: AgentRuntime, kind: string, parts: readonly string[], size: number): string {
  const namespace = runtime === "codex" ? "codex-otel" : "claude-otel";
  const digest = createHash("sha256")
    .update(`${namespace}:${kind}:${parts.join("\x1f")}`, "utf8")
    .digest("hex");
  const ident = digest.slice(0, size * 2);
  // An all-zero ID is invalid.
  return /^0+$/.test(ident) ? "0".repeat(size * 2 - 1) + "1" : ident;
}

export function traceId(sessionId: string, turnId: string, runtime: AgentRuntime = "codex"): string {
  return hexId(runtime, "trace", [sessionId, turnId], 16);
}

export function turnSpanId(sessionId: string, turnId: string, runtime: AgentRuntime = "codex"): string {
  return hexId(runtime, "turn", [sessionId, turnId], 8);
}

export function llmSpanId(sessionId: string, seq: number, runtime: AgentRuntime = "codex"): string {
  return hexId(runtime, "llm", [sessionId, String(seq)], 8);
}

export function toolSpanId(sessionId: string, callId: string, runtime: AgentRuntime = "codex"): string {
  return hexId(runtime, "tool", [sessionId, callId], 8);
}
