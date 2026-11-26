/**
 * Keeps the rate table current by fetching the one on the project's `main` branch.
 *
 * Rates change more often than anyone reinstalls a hook, and a stale table reports plausible
 * numbers that are quietly wrong. So at most once per `CAT_OTEL_PRICING_UPDATE_HOURS` (default
 * 24) the hook downloads `src/pricing.json` from GitHub and keeps it in the state directory,
 * where {@link loadPricing} prefers it over the bundled table **only when its `as_of` is newer**
 * and it passes {@link pricingProblem}'s strict checks (including the `schema` this code
 * understands). The download takes effect from the next event; the current one has already
 * loaded its rates.
 *
 * Off with `CAT_OTEL_PRICING_UPDATE=0`, and whenever `CAT_OTEL_PRICING_FILE` pins a table.
 * The request carries no user or session data: a GET with a generic User-Agent, and
 * `If-None-Match` so an unchanged table costs a 304.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";

import { debug, env, numberEnv, stateDir } from "./env.ts";
import {
  loadPricing,
  pricingCachePath,
  pricingProblem,
  pricingUpdatesEnabled,
} from "./pricing.ts";
import type { AgentRuntime } from "./types.ts";

export const DEFAULT_PRICING_URL =
  "https://raw.githubusercontent.com/okamototk/coding-agent-telemetry-exporter/main/src/pricing.json";

/** Far above the real table (~15 KB); anything bigger is not a rate table. */
const MAX_BYTES = 1_000_000;

const USER_AGENT = "agent-otel-genai-hook/1.0.0";

export type RefreshOutcome =
  | "disabled"
  | "fresh" // checked within the interval; nothing fetched
  | "updated"
  | "unchanged" // 304, or a table no newer than the one in use
  | "rejected" // fetched, but invalid
  | "failed"; // network or HTTP error

interface CheckStamp {
  checked_at?: number;
  etag?: string;
}

function stampPath(runtime: AgentRuntime): string {
  return join(stateDir(runtime), "pricing-check.json");
}

function readStamp(runtime: AgentRuntime): CheckStamp {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stampPath(runtime), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as CheckStamp) : {};
  } catch {
    return {};
  }
}

/** Writes via a temporary file and a rename, so a reader never sees half a file. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

interface Response {
  status: number;
  etag: string | null;
  body: string;
}

/** A GET that never throws: redirects are not followed, the body is capped. */
function get(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<Response | string> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const request = transport(url, { method: "GET", headers, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_BYTES) {
          request.destroy(new Error(`response over ${MAX_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const etag = response.headers["etag"];
        resolve({
          status: response.statusCode ?? 0,
          etag: typeof etag === "string" ? etag : null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", (error) => resolve(error.message));
    });
    request.on("timeout", () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on("error", (error) => resolve(error.message));
    request.end();
  });
}

/**
 * Fetches a newer rate table if one is due and available. Never throws, and does nothing
 * (beyond reading a small stamp file) when the last check is within the interval.
 */
export async function refreshPricing(
  runtime: AgentRuntime,
  now: number = Date.now(),
): Promise<RefreshOutcome> {
  if (!pricingUpdatesEnabled()) {
    return "disabled";
  }
  try {
    const stamp = readStamp(runtime);
    const intervalMs = Math.max(0, numberEnv("CAT_OTEL_PRICING_UPDATE_HOURS", 24)) * 3_600_000;
    if (typeof stamp.checked_at === "number" && now - stamp.checked_at < intervalMs) {
      return "fresh";
    }
    // Claim the check before the request, so the hook processes of one busy turn do not all
    // fetch. A failed check is retried after the next interval, not on the next event.
    writeAtomic(stampPath(runtime), JSON.stringify({ ...stamp, checked_at: now }));

    let url: URL;
    try {
      url = new URL(env(["CAT_OTEL_PRICING_URL"], DEFAULT_PRICING_URL));
    } catch (error) {
      debug(`pricing update: bad CAT_OTEL_PRICING_URL (${String(error)})`, runtime);
      return "failed";
    }
    const current = loadPricing(runtime);
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (stamp.etag) {
      headers["If-None-Match"] = stamp.etag;
    }
    const timeoutMs = Math.max(1, numberEnv("CAT_OTEL_TIMEOUT", 3) * 1000);
    const response = await get(url, headers, timeoutMs);
    if (typeof response === "string") {
      debug(`pricing update failed url=${url.href} err=${response}`, runtime);
      return "failed";
    }
    if (response.status === 304) {
      debug(`pricing update: not modified (as_of=${current.as_of ?? "?"})`, runtime);
      return "unchanged";
    }
    if (response.status !== 200) {
      debug(`pricing update failed url=${url.href} status=${response.status}`, runtime);
      return "failed";
    }
    const remember = (): void => {
      writeAtomic(
        stampPath(runtime),
        JSON.stringify({ checked_at: now, ...(response.etag ? { etag: response.etag } : {}) }),
      );
    };

    let data: unknown;
    try {
      data = JSON.parse(response.body);
    } catch (error) {
      debug(`pricing update rejected: not JSON (${String(error)})`, runtime);
      return "rejected";
    }
    const problem = pricingProblem(data);
    if (problem) {
      // Typically a table for a newer schema than this code. Its ETag is not kept: once the
      // hook is upgraded, a 304 for it would stop the table from ever being fetched.
      debug(`pricing update rejected: ${problem}`, runtime);
      return "rejected";
    }
    const asOf = (data as { as_of: string }).as_of;
    if (asOf <= (current.as_of ?? "")) {
      debug(`pricing update: as_of=${asOf} is not newer than ${current.as_of}`, runtime);
      remember();
      return "unchanged";
    }
    writeAtomic(pricingCachePath(runtime), response.body);
    remember();
    debug(`pricing updated as_of=${current.as_of ?? "?"} -> ${asOf}`, runtime);
    return "updated";
  } catch (error) {
    debug(`pricing update failed err=${String(error)}`, runtime);
    return "failed";
  }
}
