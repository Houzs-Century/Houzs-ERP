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
import { mytDayOfValue } from "../vendor/scm/lib/dates";

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

export type DateRange = { from?: string; to?: string };

/* Evaluated in MYT (UTC+8) like the rest of the app: a Date shifted by +8h has
   its UTC fields equal to the MYT wall clock, so the getUTC* family is exact. */
export function presetRange(preset: DatePreset, now = Date.now()): DateRange {
  const nowMyt = new Date(now + 8 * 3600 * 1000);
  const shifted = (days: number): string => {
    const t = new Date(nowMyt);
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
  };
  const monthEnd = (first: Date): string => {
    const e = new Date(first);
    e.setUTCMonth(e.getUTCMonth() + 1, 0);
    return e.toISOString().slice(0, 10);
  };
  switch (preset) {
    case "today":
      return { from: shifted(0), to: shifted(0) };
    case "overdue":
      return { to: shifted(-1) };
    case "tomorrow":
      return { from: shifted(1), to: shifted(1) };
    case "thisWeek": {
      const dow = (nowMyt.getUTCDay() + 6) % 7;
      return { from: shifted(-dow), to: shifted(6 - dow) };
    }
    case "thisMonth": {
      const first = new Date(nowMyt);
      first.setUTCDate(1);
      return { from: first.toISOString().slice(0, 10), to: monthEnd(first) };
    }
    case "lastMonth": {
      const first = new Date(nowMyt);
      first.setUTCDate(1);
      first.setUTCMonth(first.getUTCMonth() - 1);
      return { from: first.toISOString().slice(0, 10), to: monthEnd(first) };
    }
  }
}

/* A row is judged by the Malaysian day its value falls on: a timestamp's first
   ten characters are the UTC day, which puts 00:00-08:00 Malaysia time on the
   day before (owner 2026-11-09). */
export function dateMatchesPreset(value: string | null | undefined, preset: DatePreset, now = Date.now()): boolean {
  const d = mytDayOfValue(value);
  if (!d) return false;
  const { from, to } = presetRange(preset, now);
  return (!from || d >= from) && (!to || d <= to);
}

/** The date range a column's funnel asks for, so a server-paged list can ask the
 *  server for it: on such a list the grid holds one page, and a condition run
 *  there would judge only that page. */
export function conditionDateRange(values: readonly string[] | undefined, now = Date.now()): DateRange {
  for (const v of values ?? []) {
    const c = parseCondition(v);
    if (c?.kind === "preset") return presetRange(c.preset, now);
    if (c?.kind === "dateRange") return { ...(c.from ? { from: c.from } : {}), ...(c.to ? { to: c.to } : {}) };
  }
  return {};
}

const DATE_CELL = /^\d{4}[-/]\d{2}[-/]\d{2}/;

/** A column whose cells are all dates gets the date filter without saying so,
 *  so a new date column cannot be left without it (owner 2026-11-06). */
export function looksLikeDateColumn(values: readonly string[]): boolean {
  const cells = values.filter((v) => v.trim() !== "" && v.trim() !== "—" && v.trim() !== "-");
  return cells.length > 0 && cells.every((v) => DATE_CELL.test(v.trim()));
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
  const iso = typeof raw === "boolean" ? null : mytDayOfValue(raw);
  if (c.kind === "preset") return dateMatchesPreset(iso, c.preset);
  if (!iso) return false;
  if (c.from && iso < c.from) return false;
  if (c.to && iso > c.to) return false;
  return true;
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
