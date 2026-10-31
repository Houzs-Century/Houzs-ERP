// What Project Overview remembers, and how its project table reads (owner
// 2026-10-21).
//
// REMEMBERED IN THE URL. Back to the page keeps the period, the sort, the
// filters, the breakdown pick and the trend level, and returns to the place you
// were looking at: 「按返回：月份、排序、筛选都保持，也回到你刚才看的位置」. Coming in
// from the menu opens the page with no parameters, so it starts on the
// defaults — this month, Newest, no filter (「从 side bar 重新进入就要是 default
// 最新和没有 filter 的状态」). Every choice is written with `replace`, so Back
// leaves the page instead of stepping through each click.
//
// THE TABLE (「表很乱，看的不是很清楚」, every cost kept: 「还是需要每个费用的明细」):
// a two-line project name, amounts without "RM" and a dash for nothing.

import { fmtDayMonthRange } from "../../vendor/shared/format";
import type { Drill, OvProject } from "./projectOverviewModel";

export type SortKey = "start" | "sales" | "np" | "npPct";
export type Dim = "brand" | "eventType" | "organizer" | "venue" | "state";

export type OverviewView = {
  sort: SortKey;
  brand: string;
  type: string;
  organizer: string;
  venue: string;
  state: string;
  stage: string;
  dim: Dim;
  pick: string | null;
  drill: Drill;
};

/** The URL parameter each choice lives in. The period keeps its own
 *  (af_from / af_to, DashboardPeriod.tsx). */
export const VIEW_PARAMS = {
  sort: "ao_sort", brand: "ao_brand", type: "ao_type", organizer: "ao_org", venue: "ao_venue", state: "ao_state", stage: "ao_stage", dim: "ao_dim", pick: "ao_pick", drill: "ao_drill",
} as const;

const SORTS: readonly SortKey[] = ["start", "sales", "np", "npPct"];
const DIMS: readonly Dim[] = ["brand", "eventType", "organizer", "venue", "state"];

/** The trend opens on this year by month (owner 2026-10-17). */
export const defaultDrill = (today: string): Drill => ({ level: "yearMonths", year: Number(today.slice(0, 4)) });

export function encodeDrill(d: Drill): string {
  switch (d.level) {
    case "years": return "y";
    case "quarters": return `q${d.year}`;
    case "yearMonths": return `ym${d.year}`;
    case "months": return `m${d.year}-${d.quarter}`;
    case "weeks": return `w${d.month}`;
  }
}

/** A drill from its parameter; anything unreadable is the default. */
export function decodeDrill(s: string | null, today: string): Drill {
  const v = (s ?? "").trim();
  if (v === "y") return { level: "years" };
  let m = /^q(\d{4})$/.exec(v);
  if (m) return { level: "quarters", year: Number(m[1]) };
  m = /^ym(\d{4})$/.exec(v);
  if (m) return { level: "yearMonths", year: Number(m[1]) };
  m = /^m(\d{4})-([1-4])$/.exec(v);
  if (m) return { level: "months", year: Number(m[1]), quarter: Number(m[2]) };
  m = /^w(\d{4}-\d{2})$/.exec(v);
  if (m) return { level: "weeks", month: m[1]! };
  return defaultDrill(today);
}

/** The page's choices as the URL holds them; a missing or unknown value is its
 *  default. */
export function readView(params: URLSearchParams, today: string): OverviewView {
  const sort = params.get(VIEW_PARAMS.sort) as SortKey | null;
  const dim = params.get(VIEW_PARAMS.dim) as Dim | null;
  return {
    sort: sort && SORTS.includes(sort) ? sort : "start",
    brand: params.get(VIEW_PARAMS.brand) ?? "",
    type: params.get(VIEW_PARAMS.type) ?? "",
    organizer: params.get(VIEW_PARAMS.organizer) ?? "",
    venue: params.get(VIEW_PARAMS.venue) ?? "",
    state: params.get(VIEW_PARAMS.state) ?? "",
    stage: params.get(VIEW_PARAMS.stage) ?? "",
    dim: dim && DIMS.includes(dim) ? dim : "brand",
    pick: params.get(VIEW_PARAMS.pick) || null,
    drill: decodeDrill(params.get(VIEW_PARAMS.drill), today),
  };
}

/** The URL with some choices changed. A default is left out, so a page on its
 *  defaults has a plain URL. */
export function writeView(prev: URLSearchParams, patch: Partial<OverviewView>, today: string): URLSearchParams {
  const next = new URLSearchParams(prev);
  const set = (key: string, value: string | null, dflt: string) => {
    if (value == null || value === "" || value === dflt) next.delete(key); else next.set(key, value);
  };
  if ("sort" in patch) set(VIEW_PARAMS.sort, patch.sort ?? null, "start");
  if ("brand" in patch) set(VIEW_PARAMS.brand, patch.brand ?? null, "");
  if ("type" in patch) set(VIEW_PARAMS.type, patch.type ?? null, "");
  if ("organizer" in patch) set(VIEW_PARAMS.organizer, patch.organizer ?? null, "");
  if ("venue" in patch) set(VIEW_PARAMS.venue, patch.venue ?? null, "");
  if ("state" in patch) set(VIEW_PARAMS.state, patch.state ?? null, "");
  if ("stage" in patch) set(VIEW_PARAMS.stage, patch.stage ?? null, "");
  if ("dim" in patch) set(VIEW_PARAMS.dim, patch.dim ?? null, "brand");
  if ("pick" in patch) set(VIEW_PARAMS.pick, patch.pick ?? null, "");
  if ("drill" in patch && patch.drill) set(VIEW_PARAMS.drill, encodeDrill(patch.drill), encodeDrill(defaultDrill(today)));
  return next;
}

/* ── Where you were looking, and where a project's Back goes ─────────────────
   The project page's Back button used to go to the bare /projects, which opens
   on this month and the top of the page (owner 2026-10-21: 我点9月的project，按
   back 后又跳回10月，然后会跑回最上面). So opening a project notes TWO things:
   the address it was opened from — the project's Back goes there, period,
   sort and filters included — and where that page was scrolled, given back
   once when the page is shown again at that address. Both live in one
   per-tab store, the newest 20 kept, each for thirty minutes. */

export type OverviewScroll = { page: number; table: number; tableLeft: number };

const SCROLL_STORE = "houzs.projectOverview.scroll";
const FRESH_MS = 30 * 60 * 1000;
type Stored = Record<string, (Partial<OverviewScroll> & { href?: string; at?: number }) | undefined>;

function readStore(): Stored {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SCROLL_STORE) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function writeStore(all: Stored): void {
  try {
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
    sessionStorage.setItem(SCROLL_STORE, JSON.stringify(all));
  } catch {
    /* No storage (private mode): Back keeps the choices, just not the place. */
  }
}

const fresh = (at: unknown) => typeof at === "number" && Date.now() - at <= FRESH_MS;

/** A project is being opened from the page at `href`, scrolled to `pos`. */
export function rememberOpenedFrom(projectId: number, href: string, pos: OverviewScroll): void {
  const all = readStore();
  delete all[`scroll:${href}`];
  delete all[`back:${projectId}`];
  all[`scroll:${href}`] = { ...pos, at: Date.now() };
  all[`back:${projectId}`] = { href, at: Date.now() };
  writeStore(all);
}

/** A project is being opened from the Projects page at `href` (the list view,
    which keeps its own scroll) — only where its Back goes is noted. */
export function rememberBackTo(projectId: number, href: string): void {
  const all = readStore();
  delete all[`back:${projectId}`];
  all[`back:${projectId}`] = { href, at: Date.now() };
  writeStore(all);
}

/** Where this project's Back goes: the Projects address it was opened from,
    when that was recent; else the bare list. Same-origin /projects only. */
export function projectBackTo(projectId: number): string {
  const hit = readStore()[`back:${projectId}`];
  const href = hit?.href;
  return typeof href === "string" && /^\/projects(?:[/?]|$)/.test(href) && fresh(hit?.at) ? href : "/projects";
}

/** The scroll remembered for this address, once, while fresh. */
export function takeScroll(href: string): OverviewScroll | null {
  const all = readStore();
  const hit = all[`scroll:${href}`];
  if (!hit) return null;
  delete all[`scroll:${href}`];
  writeStore(all);
  return fresh(hit.at) ? { page: Number(hit.page) || 0, table: Number(hit.table) || 0, tableLeft: Number(hit.tableLeft) || 0 } : null;
}

/* ── The project table ───────────────────────────────────────────────────── */

/** "[AKEMI] MYHOME" over "SUNWAY PYRAMID CONVENTION CENTRE · Selangor ·
 *  10/16 - 10/18". A project missing its brand or organizer reads as its name. */
export function projectLines(p: Pick<OvProject, "name" | "brand" | "organizer" | "venue" | "state" | "startDate" | "endDate">): { title: string; detail: string } {
  const brand = (p.brand ?? "").trim();
  const organizer = (p.organizer ?? "").trim();
  const title = brand && organizer ? `[${brand}] ${organizer}` : p.name;
  const dates = p.startDate ? fmtDayMonthRange(p.startDate, p.endDate) : "";
  return { title, detail: [p.venue?.trim(), p.state?.trim(), dates].filter(Boolean).join(" · ") };
}

/** An amount in the table: no "RM" (the header says what it is), a dash for
 *  nothing so the costs that are there stand out. */
export function tableAmount(rm: number): string {
  if (!Number.isFinite(rm) || Math.abs(rm) < 0.005) return "–";
  return rm.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
