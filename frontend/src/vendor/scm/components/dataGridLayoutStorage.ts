export type DataGridLayout = {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  groupBy: string[];
  pinned: string[];
  sort: { key: string; dir: "asc" | "desc" } | null;
};

const VERSION = 1 as const;
const MAX_COLUMN_KEYS = 500;
// DataGrid's resize path accepts 40px and has no practical hard cap. Preserve
// those valid legacy choices while bounding obviously corrupt numeric input.
const MIN_WIDTH = 40;
const MAX_WIDTH = 10_000;

export const DEFAULT_DATA_GRID_LAYOUT: DataGridLayout = {
  order: [],
  hidden: [],
  widths: {},
  groupBy: [],
  pinned: [],
  sort: null,
};

type StoredLayout = {
  version: typeof VERSION;
  layout: DataGridLayout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_COLUMN_KEYS) break;
  }
  return result;
}

function sanitizeWidths(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  let count = 0;
  for (const [key, width] of Object.entries(value)) {
    if (
      key.length === 0 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      typeof width !== "number" ||
      !Number.isFinite(width)
    ) continue;
    result[key] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
    count += 1;
    if (count >= MAX_COLUMN_KEYS) break;
  }
  return result;
}

function sanitizeSort(value: unknown): DataGridLayout["sort"] {
  if (!isRecord(value)) return null;
  if (typeof value.key !== "string" || value.key.length === 0) return null;
  if (value.dir !== "asc" && value.dir !== "desc") return null;
  return { key: value.key, dir: value.dir };
}

export function sanitizeDataGridLayout(value: unknown): DataGridLayout {
  if (!isRecord(value)) return { ...DEFAULT_DATA_GRID_LAYOUT };
  return {
    order: sanitizeKeys(value.order),
    hidden: sanitizeKeys(value.hidden),
    widths: sanitizeWidths(value.widths),
    groupBy: sanitizeKeys(value.groupBy),
    pinned: sanitizeKeys(value.pinned),
    sort: sanitizeSort(value.sort),
  };
}

export function serializeDataGridLayout(layout: DataGridLayout): string {
  const stored: StoredLayout = { version: VERSION, layout: sanitizeDataGridLayout(layout) };
  return JSON.stringify(stored);
}

export type DecodedDataGridLayout = {
  layout: DataGridLayout;
  /** True only for the pre-version envelope shape, so callers can migrate it. */
  legacy: boolean;
  valid: boolean;
};

export function decodeDataGridLayout(raw: string): DecodedDataGridLayout {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { layout: { ...DEFAULT_DATA_GRID_LAYOUT }, legacy: false, valid: false };
    }

    if ("version" in parsed) {
      if (parsed.version !== VERSION || !isRecord(parsed.layout)) {
        return { layout: { ...DEFAULT_DATA_GRID_LAYOUT }, legacy: false, valid: false };
      }
      return { layout: sanitizeDataGridLayout(parsed.layout), legacy: false, valid: true };
    }

    // Pre-version DataGrid values stored the layout object directly. Accept and
    // sanitize that one known shape; the reader rewrites it in the v1 envelope.
    const knownFields = ["order", "hidden", "widths", "groupBy", "pinned", "sort"];
    if (!knownFields.some((field) => field in parsed)) {
      return { layout: { ...DEFAULT_DATA_GRID_LAYOUT }, legacy: false, valid: false };
    }
    return { layout: sanitizeDataGridLayout(parsed), legacy: true, valid: true };
  } catch {
    return { layout: { ...DEFAULT_DATA_GRID_LAYOUT }, legacy: false, valid: false };
  }
}

/**
 * DataGrid storage keys whose layout is SHARED ACROSS COMPANIES — the four
 * Delivery/TMS queue boards, which render ONE cross-company queue (owner
 * 2026-08-19: "去看了 sales order 之后倒回去就会 reset"). Per-company scoping
 * (owner 2026-07-24) is right for the per-tenant lists, but on a shared queue
 * it forked the SAME board into one layout slot per company: whichever company
 * the window happened to be on picked the slot, so flipping windows read the
 * OTHER slot's (stale) arrangement — experienced as the board "resetting".
 * These keys store ONE unscoped local entry, and the server pins their row to
 * one canonical company (backend routes/tableLayouts.ts, the same key list).
 */
export const SHARED_DATA_GRID_STORAGE_KEYS: ReadonlySet<string> = new Set([
  "dg-delivery-planning",
  "dg-date-arrangement-v2",
  "dg-trips-time-arrangement-v2",
  "dg-last-mile",
]);

export const isSharedDataGridStorageKey = (storageKey: string): boolean =>
  SHARED_DATA_GRID_STORAGE_KEYS.has(storageKey);

export function readDataGridLayout(key: string, legacyKey?: string): DataGridLayout {
  if (typeof window === "undefined") return { ...DEFAULT_DATA_GRID_LAYOUT };
  try {
    // `legacyKey` is the pre-company-scoping key (owner 2026-07-24): when the
    // company-scoped entry is still empty, seed from the old shared value so a
    // user's existing columns carry over instead of resetting. Read-only — the
    // scoped key owns writes from here, so the shared value stops being touched
    // and the cross-company bleed ends.
    const raw = window.localStorage.getItem(key)
      ?? (legacyKey ? window.localStorage.getItem(legacyKey) : null);
    if (!raw) return { ...DEFAULT_DATA_GRID_LAYOUT };
    const decoded = decodeDataGridLayout(raw);
    if (decoded.valid && decoded.legacy) {
      window.localStorage.setItem(key, serializeDataGridLayout(decoded.layout));
    }
    return decoded.layout;
  } catch {
    return { ...DEFAULT_DATA_GRID_LAYOUT };
  }
}

export function writeDataGridLayout(key: string, layout: DataGridLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, serializeDataGridLayout(layout));
  } catch {
    // localStorage can be disabled or full. Layout persistence is best-effort.
  }
}

/**
 * Turn the pristine-defaults OVERLAY into stored state.
 *
 * A grid whose `order` and `hidden` are both empty is "no explicit choices
 * yet", and DataGrid overlays the `defaultHidden` columns on top of it at read
 * time. That overlay is DERIVED, so a mutator that writes either field without
 * materialising it first is writing against a layout that does not exist, and
 * the overlay reasserts the moment the write lands back on the pristine shape —
 * which is why "Show <column>" on a never-adjusted grid did nothing at all, and
 * why hiding one column silently un-hid the rest. BUG-HISTORY 2026-08-14.
 *
 * BOTH fields are written: `order` is what makes the layout non-pristine
 * however few columns end up hidden. Lives here, next to the shape it edits, so
 * every mutator can share one implementation.
 */
export function materializeDataGridLayout(
  layout: DataGridLayout,
  columns: ReadonlyArray<{ key: string; defaultHidden?: boolean }>,
): DataGridLayout {
  if (layout.order.length || layout.hidden.length) return layout;
  return {
    ...layout,
    hidden: columns.filter((c) => c.defaultHidden).map((c) => c.key),
    order: columns.map((c) => c.key),
  };
}
