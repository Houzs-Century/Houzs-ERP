/**
 * Column filters that are a CONDITION rather than a ticked value: a date preset
 * ("This week"), a date range, a number range. Carried from the SCM DataGrid so
 * its pages can move onto DataTable (one-table plan, owner 2026-09-25).
 *
 * A condition travels inside the same `{ colKey: string[] }` record the value
 * funnel uses, as a token no cell value can equal (it starts with a control
 * character). That keeps ONE filter state, so persistence, the Reset button and
 * the active-filter counts need no second path.
 */
import type { ReactNode } from "react";

const MARK = "\u0001";

export type DatePreset = "today" | "tomorrow" | "thisWeek" | "thisMonth" | "lastMonth" | "overdue";

export const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "thisWeek", label: "This Week" },
  { key: "thisMonth", label: "This Month" },
  { key: "lastMonth", label: "Last Month" },
  { key: "overdue", label: "Overdue" },
];

export type Condition =
  | { kind: "preset"; preset: DatePreset }
  | { kind: "dateRange"; from: string | null; to: string | null }
  | { kind: "numRange"; min: number | null; max: number | null };

export const isConditionToken = (v: string): boolean => v.startsWith(MARK);

export function conditionToken(c: Condition): string {
  switch (c.kind) {
    case "preset":
      return `${MARK}preset:${c.preset}`;
    case "dateRange":
      return `${MARK}dateRange:${c.from ?? ""}..${c.to ?? ""}`;
    case "numRange":
      return `${MARK}numRange:${c.min ?? ""}..${c.max ?? ""}`;
  }
}

export function parseCondition(token: string): Condition | null {
  if (!isConditionToken(token)) return null;
  const [kind, arg = ""] = token.slice(1).split(/:(.*)/s);
  if (kind === "preset") {
    return DATE_PRESETS.some((p) => p.key === arg) ? { kind: "preset", preset: arg as DatePreset } : null;
  }
  const [a = "", b = ""] = arg.split("..");
  if (kind === "dateRange") return { kind: "dateRange", from: a || null, to: b || null };
  if (kind === "numRange") {
    const num = (s: string) => (s === "" || !Number.isFinite(Number(s)) ? null : Number(s));
    return { kind: "numRange", min: num(a), max: num(b) };
  }
  return null;
}

/* Evaluated in MYT (UTC+8) like the rest of the app: a Date shifted by +8h has
   its UTC fields equal to the MYT wall clock, so the getUTC* family is exact. */
export function dateMatchesPreset(iso: string | null | undefined, preset: DatePreset, now = Date.now()): boolean {
  if (!iso) return false;
  const d = String(iso).slice(0, 10);
  if (d.length < 10) return false;
  const nowMyt = new Date(now + 8 * 3600 * 1000);
  const today = nowMyt.toISOString().slice(0, 10);
  switch (preset) {
    case "today":
      return d === today;
    case "overdue":
      return d < today;
    case "tomorrow": {
      const t = new Date(nowMyt);
      t.setUTCDate(t.getUTCDate() + 1);
      return d === t.toISOString().slice(0, 10);
    }
    case "thisWeek": {
      const dow = (nowMyt.getUTCDay() + 6) % 7;
      const mon = new Date(nowMyt);
      mon.setUTCDate(mon.getUTCDate() - dow);
      const sun = new Date(mon);
      sun.setUTCDate(sun.getUTCDate() + 6);
      return d >= mon.toISOString().slice(0, 10) && d <= sun.toISOString().slice(0, 10);
    }
    case "thisMonth":
      return d.slice(0, 7) === today.slice(0, 7);
    case "lastMonth": {
      const lm = new Date(nowMyt);
      lm.setUTCDate(1);
      lm.setUTCMonth(lm.getUTCMonth() - 1);
      return d.slice(0, 7) === lm.toISOString().slice(0, 7);
    }
  }
}

type Cell = string | number | boolean | null | undefined;

export interface ConditionColumn<T> {
  getValue?: (row: T) => Cell;
  dateValue?: (row: T) => string | null | undefined;
  numberValue?: (row: T) => number | null | undefined;
}

export function rowMatchesCondition<T>(row: T, c: Condition, col: ConditionColumn<T>): boolean {
  if (c.kind === "numRange") {
    const raw = col.numberValue ? col.numberValue(row) : col.getValue?.(row);
    if (raw == null || raw === "") return false;
    const n = Number(raw);
    if (Number.isNaN(n)) return false;
    if (c.min != null && n < c.min) return false;
    if (c.max != null && n > c.max) return false;
    return true;
  }
  const raw = col.dateValue ? col.dateValue(row) : col.getValue?.(row);
  const iso = raw == null ? "" : String(raw).slice(0, 10);
  if (c.kind === "preset") return dateMatchesPreset(iso, c.preset);
  if (!iso) return false;
  if (c.from && iso < c.from) return false;
  if (c.to && iso > c.to) return false;
  return true;
}

/** How an active condition reads on its chip / in the funnel header. */
export function conditionLabel(c: Condition): string {
  if (c.kind === "preset") return DATE_PRESETS.find((p) => p.key === c.preset)?.label ?? c.preset;
  if (c.kind === "dateRange") return `${c.from ?? "…"} to ${c.to ?? "…"}`;
  return `${c.min ?? "…"} to ${c.max ?? "…"}`;
}

/* ── Toolbar text search over the loaded rows (DataGrid parity) ─────────── */

export interface SearchColumn<T> {
  searchValue?: (row: T) => string | null | undefined;
  getValue?: (row: T) => Cell;
  render?: (row: T) => ReactNode;
}

/** One lowercased blob per row. '\n' between columns so two adjacent cells can
 *  never form a false match across their boundary. */
export function buildSearchBlob<T>(row: T, columns: readonly SearchColumn<T>[]): string {
  let blob = "";
  for (const c of columns) {
    let v: unknown = c.searchValue ? c.searchValue(row) : c.getValue?.(row);
    if (v == null && c.render) {
      const node = c.render(row);
      v = typeof node === "string" || typeof node === "number" ? node : "";
    }
    blob += `${String(v ?? "").toLowerCase()}\n`;
  }
  return blob;
}
