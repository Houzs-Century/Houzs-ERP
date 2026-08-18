import { fmtDate, fmtDateTime, fmtTimestamp } from "@2990s/shared";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function formatCurrency(n: number | null | undefined, opts?: { compact?: boolean }): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `RM ${(n / 1_000_000).toFixed(2)}M`;
    if (Math.abs(n) >= 1_000) return `RM ${(n / 1_000).toFixed(1)}K`;
  }
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n.toLocaleString("en-MY");
}

// ── Time zone ────────────────────────────────────────────────
//
// All audit timestamps in the DB are written via SQLite `datetime('now')`,
// which returns UTC strings like `2026-05-28 17:30:00`. The team operates
// in Malaysia / Singapore time (GMT+8) and everything that surfaces a
// real-world moment must be displayed in that zone, not in whatever
// timezone the user's browser happens to be set to.
//
// User-entered scheduling fields (setup_start_at, payment_date, …) take
// a different shape — `YYYY-MM-DDTHH:MM`, sourced from `<input
// type="datetime-local">` — and are stored as wall-clock strings with no
// timezone implied. Those must NOT be converted; we display whatever
// the user typed.
//
// The two cases are distinguishable by the string itself (see the
// helpers below) so a single formatter picks the right branch.

export const APP_TZ = "Asia/Kuala_Lumpur";

function isWallClockDateTime(s: string): boolean {
  // Format produced by datetime-local input. 16 chars, T separator,
  // no seconds → we treat this as wall-clock-as-typed.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
}

function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Parse a timestamp string into a Date, treating bare SQLite "YYYY-MM-DD HH:MM:SS"
 * values as UTC.
 *
 * SQLite's `datetime('now')` returns an unzoned UTC string like
 *   2026-04-08 11:30:00
 * JavaScript's `new Date()` parses unzoned strings as LOCAL time, which
 * silently shifts the value by the user's timezone offset (e.g. 8 hours
 * for GMT+8) and produces stale "Xh ago" labels for rows that were just
 * created. We normalize by appending "Z" so the parser treats it as UTC.
 *
 * Already-zoned ISO strings (containing T/Z/+/-) are passed through as-is.
 */
export function parseDate(d: string | null | undefined): Date | null {
  if (!d) return null;
  let s = d;
  // Bare SQLite timestamp: "YYYY-MM-DD HH:MM:SS[.fff]" → tag as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  const date = new Date(s);
  return isNaN(date.getTime()) ? null : date;
}

/* THE DATE RULE LIVES IN ONE PLACE — `@2990s/shared`'s `fmtDate`.
   These three names stay because 154 call sites use them, but they no longer
   carry a copy of the rule: they forward to it. The rule they used to hold
   (numeric DD/MM/YYYY, no month names, date-only shown verbatim, instants
   converted once into GMT+8) is now the shared module's, comment and all, and
   it is the same rule the SPA lists, the detail pages and the PDFs use.

   The old bodies here were the BEST of the five spellings in the tree — they
   were the only ones that branched on the input's shape instead of trusting
   `new Date()`. That branching is what moved into the shared module; nothing
   about what a user sees changes on this path. */
export function formatDate(d: string | null | undefined): string {
  return fmtDate(d);
}

/** DD/MM/YYYY HH:mm (24h, GMT+8). See {@link formatDate}. */
export function formatDateTime(d: string | null | undefined): string {
  return fmtDateTime(d);
}

/**
 * DD/MM/YYYY HH:mm:ss in GMT+8. Use this for audit timestamps where
 * the full second is meaningful (activity log, attachment uploaded_at,
 * etc.). For scheduling fields prefer formatDateTime.
 */
export function formatTimestamp(d: string | null | undefined): string {
  return fmtTimestamp(d);
}

export function relativeTime(d: string | null | undefined): string {
  if (!d) return "—";
  const date = parseDate(d);
  if (!date) return "—";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  // Negative diffs (clock skew) → treat as "just now" instead of "in 5s"
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  // Past one week — fall back to the absolute date in DD/MM/YYYY (GMT+8),
  // matching the rest of the SPA's date format.
  return fmtDate(date);
}

/**
 * "Today" in GMT+8, returned as YYYY-MM-DD so callers can compare to
 * date-only DB columns without timezone surprises.
 */
export function todayInAppTz(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

export function isExpired(d: string | null | undefined): boolean {
  if (!d) return false;
  const today = todayInAppTz();
  // Date-only / wall-clock fields compare directly as strings.
  const datePart = isDateOnly(d) || isWallClockDateTime(d) ? d.slice(0, 10) : null;
  if (datePart) return datePart < today;
  // Audit timestamp — compare its GMT+8 calendar date.
  const date = parseDate(d);
  if (!date) return false;
  const inTz = fmtDate(d); // DD/MM/YYYY
  if (inTz === "—") return false;
  // Convert DD/MM/YYYY → YYYY-MM-DD for lexicographic compare.
  const [dd, mm, yyyy] = inTz.split("/");
  return `${yyyy}-${mm}-${dd}` < today;
}

export function isExpiringSoon(d: string | null | undefined, days = 3): boolean {
  if (!d) return false;
  const today = todayInAppTz();
  // Compute cutoff in GMT+8 by anchoring midnight at this calendar date.
  const cutoff = new Date(`${today}T00:00:00+08:00`);
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = fmtDate(cutoff);
  const [cd, cm, cy] = cutoffStr.split("/");
  const cutoffIso = `${cy}-${cm}-${cd}`;

  const datePart =
    isDateOnly(d) || isWallClockDateTime(d) ? d.slice(0, 10) : null;
  if (datePart) return datePart >= today && datePart <= cutoffIso;

  const inTz = fmtDate(d);
  if (inTz === "—") return false;
  const [dd, mm, yyyy] = inTz.split("/");
  const iso = `${yyyy}-${mm}-${dd}`;
  return iso >= today && iso <= cutoffIso;
}

// ── Search highlight ─────────────────────────────────────────
//
// Pure splitter used by BOTH the desktop Cmd+K palette and the mobile search
// palette to BOLD the matched keyword in a result. Kept framework-free here (a
// plain segment array) so this `.ts` module carries no JSX; the rendering
// wrapper (<HighlightedText>) lives in lib/highlight.tsx.
//
// Case-insensitive, matches EVERY occurrence of `query` in `text`. The query is
// regex-escaped so a term with special chars (a sofa code like `1A(LHF)`, a
// phone with `+`) never breaks the split. Returns the original text as one
// non-matching segment when the query is empty or absent.

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function splitHighlight(
  text: string | null | undefined,
  query: string | null | undefined,
): HighlightSegment[] {
  const s = text ?? "";
  const q = (query ?? "").trim();
  if (!s) return [];
  if (q.length === 0) return [{ text: s, match: false }];
  // Escape regex metacharacters in the user's query.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(`(${escaped})`, "gi");
  } catch {
    return [{ text: s, match: false }];
  }
  const out: HighlightSegment[] = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: s.slice(last, idx), match: false });
    out.push({ text: m[0], match: true });
    last = idx + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), match: false });
  return out;
}
