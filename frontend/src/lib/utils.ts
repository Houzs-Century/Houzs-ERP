import { fmtDate, fmtDateTime, fmtTimestamp } from "../../../shared/src/vendor/shared/format";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** A RINGGIT number → "RM 15,000.00", the way AutoCount prints it. There is no
 *  compact form: it used to abbreviate to "RM 15.0K", and the owner's rule
 *  (2026-09-15) is that every amount reads in full. docs/bugs/0926-money-on-some-screens-read-as-whole-ringgit-as-rm-15-0k-or-w.md. */
export function formatCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n.toLocaleString("en-MY");
}


export const APP_TZ = "Asia/Kuala_Lumpur";

function isWallClockDateTime(s: string): boolean {
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
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  const date = new Date(s);
  return isNaN(date.getTime()) ? null : date;
}

export function formatDate(d: string | null | undefined): string {
  return fmtDate(d);
}

/** yyyy/mm/dd HH:mm (24h, GMT+8). See {@link formatDate}. */
export function formatDateTime(d: string | null | undefined): string {
  return fmtDateTime(d);
}

/**
 * yyyy/mm/dd HH:mm:ss in GMT+8. Use this for audit timestamps where
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
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
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
  const datePart = isDateOnly(d) || isWallClockDateTime(d) ? d.slice(0, 10) : null;
  if (datePart) return datePart < today;
  const date = parseDate(d);
  if (!date) return false;
  const inTz = fmtDate(d);
  if (inTz === "—") return false;
  return inTz.replace(/\//g, "-") < today;
}

export function isExpiringSoon(d: string | null | undefined, days = 3): boolean {
  if (!d) return false;
  const today = todayInAppTz();
  const cutoff = new Date(`${today}T00:00:00+08:00`);
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffIso = fmtDate(cutoff).replace(/\//g, "-");

  const datePart =
    isDateOnly(d) || isWallClockDateTime(d) ? d.slice(0, 10) : null;
  if (datePart) return datePart >= today && datePart <= cutoffIso;

  const inTz = fmtDate(d);
  if (inTz === "—") return false;
  const iso = inTz.replace(/\//g, "-");
  return iso >= today && iso <= cutoffIso;
}


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
