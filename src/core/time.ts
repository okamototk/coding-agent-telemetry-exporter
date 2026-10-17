/** Time helpers. Span timestamps are nanoseconds, so they are held as bigint. */

export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Converts a state-file value (number or decimal string) to a nanosecond bigint. */
export function toNs(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

/**
 * Converts a rollout ISO 8601 timestamp to nanoseconds. Date.parse only resolves to
 * milliseconds, so sub-millisecond digits are read from the string directly (Codex
 * writes three fractional digits, but the count is not guaranteed).
 */
export function isoToNs(value: unknown): bigint | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  let ns = BigInt(ms) * 1_000_000n;
  const digits = /\.(\d+)/.exec(value)?.[1];
  if (digits && digits.length > 3) {
    // Date.parse already consumed the first 3 digits as ms; the rest is sub-ms.
    ns += BigInt(digits.slice(3).padEnd(6, "0").slice(0, 6));
  }
  return ns;
}

/** Local timestamp prefixed to each hook.log line (`2026-08-25T10:00:00+0900`). */
export function localTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  );
}
