// Per-column FILTERS for the vendored SCM DataGrid — the funnel value sets,
// date presets, number ranges and custom date ranges. The DataTable twin of
// this store lives in components/dataTableColFilterMemory.
//
// IN-VISIT memory: ONE entry per grid in a module-scoped Map, keyed by the SAME
// company-scoped (or shared-board unscoped) key the grid's layout blob uses, so
// filters follow exactly the layout's company semantics. Module scope survives
// a client-side route change (opening a record and coming back remounts the
// grid but keeps the module loaded), so a funnel set this visit is NOT lost —
// the owner's 2026-08-19 rule ("漏斗和页签被清掉,也做成和 service case 一样"). It is
// WIPED on a full page load / new tab / F5, because the bundle re-evaluates and
// this Map starts empty — the owner's 2026-09-16 rule that a list opens with NO
// funnel on a fresh entry.
//
// Deliberately NOT localStorage (that survived across sessions — the stale
// funnel the owner hit on the PO list) and NOT sessionStorage (that survives an
// F5, which must be clean). The grid's LAYOUT blob (`dg-<idKey>` / column order,
// widths, saved views) stays in localStorage; only the funnel filters moved
// here. `purgeStoredDataGridFilters` erases the pre-2026-09-16 `dg-filters:*`
// localStorage keys on mount so a stale one cannot re-narrow a list.

export type DataGridFilters = {
  /** colKey → allowed values (the funnel's tick list). Absent = no filter. */
  values: Record<string, string[]>;
  /** colKey → date-preset key (`filterType: 'date'`). Unknown presets are
   *  kept — the grid treats an unrecognised preset as no-op rather than
   *  guessing, so a preset added later survives a round-trip through an old
   *  bundle. */
  dates: Record<string, string>;
  /** colKey → numeric bounds (`filterType: 'number'`). */
  numbers: Record<string, { min?: number; max?: number }>;
  /** colKey → custom ISO date range (`filterType: 'date'`, ANDs with preset). */
  dateRanges: Record<string, { from?: string; to?: string }>;
};

const MAX_KEYS = 200;
const MAX_VALUES_PER_KEY = 500;

export const EMPTY_DATA_GRID_FILTERS: DataGridFilters = {
  values: {},
  dates: {},
  numbers: {},
  dateRanges: {},
};

const storageKeyFor = (idKey: string): string => `dg-filters:${idKey}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const badKey = (k: string): boolean =>
  k.length === 0 || k === "__proto__" || k === "prototype" || k === "constructor";

function sanitizeValues(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (badKey(k) || !Array.isArray(v)) continue;
    const vals = v.filter((x): x is string => typeof x === "string").slice(0, MAX_VALUES_PER_KEY);
    if (vals.length === 0) continue;
    out[k] = vals;
    if (++keys >= MAX_KEYS) break;
  }
  return out;
}

function sanitizeDates(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (badKey(k) || typeof v !== "string" || v.length === 0 || v.length > 64) continue;
    out[k] = v;
    if (++keys >= MAX_KEYS) break;
  }
  return out;
}

function sanitizeNumbers(raw: unknown): Record<string, { min?: number; max?: number }> {
  if (!isRecord(raw)) return {};
  const out: Record<string, { min?: number; max?: number }> = Object.create(null) as Record<
    string,
    { min?: number; max?: number }
  >;
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (badKey(k) || !isRecord(v)) continue;
    const bound: { min?: number; max?: number } = {};
    if (typeof v.min === "number" && Number.isFinite(v.min)) bound.min = v.min;
    if (typeof v.max === "number" && Number.isFinite(v.max)) bound.max = v.max;
    if (bound.min === undefined && bound.max === undefined) continue;
    out[k] = bound;
    if (++keys >= MAX_KEYS) break;
  }
  return out;
}

function sanitizeDateRanges(raw: unknown): Record<string, { from?: string; to?: string }> {
  if (!isRecord(raw)) return {};
  const out: Record<string, { from?: string; to?: string }> = Object.create(null) as Record<
    string,
    { from?: string; to?: string }
  >;
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (badKey(k) || !isRecord(v)) continue;
    const range: { from?: string; to?: string } = {};
    if (typeof v.from === "string" && v.from.length > 0 && v.from.length <= 32) range.from = v.from;
    if (typeof v.to === "string" && v.to.length > 0 && v.to.length <= 32) range.to = v.to;
    if (range.from === undefined && range.to === undefined) continue;
    out[k] = range;
    if (++keys >= MAX_KEYS) break;
  }
  return out;
}

export function sanitizeDataGridFilters(raw: unknown): DataGridFilters {
  if (!isRecord(raw)) return { ...EMPTY_DATA_GRID_FILTERS };
  return {
    values: sanitizeValues(raw.values),
    dates: sanitizeDates(raw.dates),
    numbers: sanitizeNumbers(raw.numbers),
    dateRanges: sanitizeDateRanges(raw.dateRanges),
  };
}

export function isEmptyDataGridFilters(f: DataGridFilters): boolean {
  return (
    Object.keys(f.values).length === 0 &&
    Object.keys(f.dates).length === 0 &&
    Object.keys(f.numbers).length === 0 &&
    Object.keys(f.dateRanges).length === 0
  );
}

// In-visit store: idKey -> its funnel filters. Wiped when the bundle
// re-evaluates on a full page load; kept across a client-side route change.
const memory = new Map<string, DataGridFilters>();

/** Read the grid's in-visit funnel filters. Each facet is sanitised on write,
 *  so a returned entry is already clean; a clone keeps a caller from mutating
 *  the stored object in place. */
export function readDataGridFilters(idKey: string): DataGridFilters {
  const held = memory.get(idKey);
  return held ? sanitizeDataGridFilters(held) : { ...EMPTY_DATA_GRID_FILTERS };
}

export function writeDataGridFilters(idKey: string, filters: DataGridFilters): void {
  const clean = sanitizeDataGridFilters(filters);
  // No filters = no entry: an empty entry would read as "a saved view of
  // everything" and make Clear look like it failed.
  if (isEmptyDataGridFilters(clean)) memory.delete(idKey);
  else memory.set(idKey, clean);
}

/** Remove the pre-2026-09-16 localStorage funnel blob for this grid. Funnels no
 *  longer persist to disk; a leftover key would re-narrow a list on next login. */
export function purgeStoredDataGridFilters(idKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKeyFor(idKey));
  } catch {
    // storage unavailable: nothing to erase
  }
}

// Test seam: simulate a fresh page load by emptying the in-visit store.
export function resetDataGridFilterMemory(): void {
  memory.clear();
}
