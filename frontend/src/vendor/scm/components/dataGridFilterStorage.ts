// Persisted per-column FILTERS for the vendored SCM DataGrid — the funnel
// value sets, date presets, number ranges and custom date ranges that used to
// be React state only, so any unmount (opening a record replaces the workspace
// tab) silently cleared them. Owner 2026-08-19, after the shared-board layout
// fix: "漏斗和页签被清掉,也做成和 service case 一样" — DataTable has persisted
// its funnels since 2026-07-29 (`dt:filters:*`); this is the DataGrid twin.
//
// Storage: ONE JSON blob per grid under `dg-filters:<idKey>`, where idKey is
// the SAME company-scoped (or shared-board unscoped) key the grid's layout
// blob uses — filters follow exactly the layout's company semantics. The
// `dg-` prefix keeps the key inside the registered grid-layout DEVICE_PREF
// family (lib/browserStorageRegistry.ts). Filters are deliberately NOT synced
// to the account (lib/tableLayouts.ts): they are a working view, not a layout
// — same split DataTable ships with.

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

const VERSION = 1 as const;
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

/** Unlike the layout blob's all-or-nothing decode, each FACET sanitises
 *  independently, so one corrupt entry costs that entry, never the rest. */
export function readDataGridFilters(idKey: string): DataGridFilters {
  if (typeof window === "undefined") return { ...EMPTY_DATA_GRID_FILTERS };
  try {
    const raw = window.localStorage.getItem(storageKeyFor(idKey));
    if (!raw) return { ...EMPTY_DATA_GRID_FILTERS };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== VERSION) return { ...EMPTY_DATA_GRID_FILTERS };
    return sanitizeDataGridFilters(parsed);
  } catch {
    return { ...EMPTY_DATA_GRID_FILTERS };
  }
}

export function writeDataGridFilters(idKey: string, filters: DataGridFilters): void {
  if (typeof window === "undefined") return;
  try {
    const clean = sanitizeDataGridFilters(filters);
    // No filters = no key: an empty entry would read as "a saved view of
    // everything" and make Clear look like it failed to persist.
    if (isEmptyDataGridFilters(clean)) {
      window.localStorage.removeItem(storageKeyFor(idKey));
      return;
    }
    window.localStorage.setItem(storageKeyFor(idKey), JSON.stringify({ version: VERSION, ...clean }));
  } catch {
    // Quota / privacy mode — filters stay working state for this session.
  }
}
