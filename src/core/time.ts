/**
 * Timestamp helpers. Canonical format is LOCAL machine time with offset
 * (ISO-8601, e.g. 2026-07-06T12:24:32+03:00) — matches the ledger's original
 * hand-authored style and stays unambiguous. Centralized here so the CLI,
 * dashboard, and MCP layers all agree (resolves issue-timestamp-format).
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Current (or given) time as local ISO-8601 with numeric offset. */
export function nowIso(d: Date = new Date()): string {
  const offsetMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Compact local stamp for ids, e.g. 20260706-122433 (second resolution). */
export function idStamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Sanitize a string for safe use as an id / filename component: only
 * [A-Za-z0-9._-] survive, preventing path separators and traversal
 * (e.g. an agent named "../../foo" cannot escape the messages dir).
 */
export function safeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "x";
}

/**
 * Order records by their `created_at` using OFFSET-AWARE parsing, then by id
 * for stability. Timestamps are local ISO with a numeric offset, so a lexical
 * string compare mis-orders across differing offsets (e.g. `+00:00` vs
 * `+03:00`); `Date.parse` compares the real instants. Falls back to id when
 * either timestamp is unparseable or the instants are equal (audit M8).
 */
export function byCreatedAtThenId(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
  return a.id.localeCompare(b.id);
}
