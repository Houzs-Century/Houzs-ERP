// Server-stored column layouts — the account-level half of the Columns panel
// (owner 2026-08-01). Backend: routes/tableLayouts.ts, mig 0236 / D1 142.
//
// Two things live here, both fed by ONE boot request:
//
//   • MINE — this user's arrangement per table, so it follows the account to
//     another machine instead of dying with a localStorage.
//   • DEFAULTS — each company's admin-set default view, offered in the Columns
//     panel as a one-click preset (including the OTHER company's, which is the
//     ask this feature started from) and used as the baseline for anyone who
//     has never arranged that table.
//
// ── localStorage STAYS THE RENDER SOURCE ──────────────────────────────────
// DataTable reads its prefs synchronously from localStorage, which is what
// makes a list render with the right columns on the FIRST paint. This module
// does not change that: it hydrates those same keys from the server once, then
// mirrors every later change back up. So the server is a sync channel, not a
// dependency — offline, pre-migration, or with the request failing, every table
// behaves exactly as it did before this existed.
//
// Nothing here runs until `hydrateTableLayouts()` succeeds. Before that the
// module is inert: no writes, no extra storage keys, no pushes. That is what
// keeps unit tests (and a logged-out tab) on the old code path exactly.

import { api } from "../api/client";
import { getActiveCompanyId } from "./activeCompany";
import {
  readDataGridLayout,
  writeDataGridLayout,
} from "../vendor/scm/components/dataGridLayoutStorage";

/** The persisted shape of one table's layout. Filters / sort / card-vs-table
 *  are deliberately NOT here: those are working state, not a layout. */
export interface StoredLayout {
  order: string[];
  hidden: string[];
  shown: string[];
  widths: Record<string, number>;
  pinned: string[];
  /** Group-by columns — vendored SCM DataGrid only, where grouping a list by
   *  supplier is part of its shape. Always empty for a DataTable. */
  groupBy: string[];
}

export const EMPTY_LAYOUT: StoredLayout = {
  order: [],
  hidden: [],
  shown: [],
  widths: {},
  pinned: [],
  groupBy: [],
};

/**
 * Which grid a saved row belongs to, and therefore which localStorage shape it
 * hydrates into. The app runs TWO table components that persist columns
 * differently — five `dt:<part>:<key>` entries for DataTable, one JSON blob
 * under `<storageKey>::c<company>` for the vendored SCM DataGrid. The server
 * stores one shape for both; the prefix on the table key is what tells them
 * apart on the way back down, so hydration can never write one component's
 * shape into the other's key.
 */
export type LayoutFamily = "dt" | "dg";

export const DG_PREFIX = "dg:";

/** Server table key for a vendored-DataGrid list. */
export const dataGridTableKey = (storageKey: string): string => `${DG_PREFIX}${storageKey}`;

const familyOf = (tableKey: string): LayoutFamily =>
  tableKey.startsWith(DG_PREFIX) ? "dg" : "dt";

export interface LayoutCompany {
  id: number;
  code: string;
  name: string;
}

/** A column set the user saved and can switch back to (mig 0239). Switching
 *  COPIES it into the live arrangement — it is data, not a pointer, which is
 *  why saving one never disturbs the sync of what is on screen. */
export interface NamedLayout {
  id: number;
  name: string;
  layout: StoredLayout;
}

export interface TableLayoutsSnapshot {
  /** True once the boot fetch has succeeded. Everything below is empty until. */
  ready: boolean;
  companies: LayoutCompany[];
  activeCompanyId: number | null;
  /** May this user write a company-wide default? (settings.manage) */
  canManageDefaults: boolean;
  /** May this user create / rename / delete layouts, and name the company
   *  default? Owner and Super Admin only — the "*" wildcard. */
  canManageLayouts: boolean;
  /** companyId → tableKey → the company's default layout. */
  defaults: Record<string, Record<string, StoredLayout>>;
  /** companyId → tableKey → the name an admin gave that default. Absent means
   *  the picker names it after the company instead. */
  defaultNames: Record<string, Record<string, string>>;
  /** tableKey → this user's saved layouts, in the active company. */
  myLayouts: Record<string, NamedLayout[]>;
  /** Bumped whenever hydration changed stored prefs, so a mounted table can
   *  re-read localStorage (it is read once, at mount, by design). */
  epoch: number;
}

const EMPTY: TableLayoutsSnapshot = {
  ready: false,
  companies: [],
  activeCompanyId: null,
  canManageDefaults: false,
  canManageLayouts: false,
  defaults: {},
  defaultNames: {},
  myLayouts: {},
  epoch: 0,
};

let snapshot: TableLayoutsSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(next: TableLayoutsSnapshot): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

export function subscribeTableLayouts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getTableLayoutsSnapshot(): TableLayoutsSnapshot {
  return snapshot;
}

/** Test seam: drop everything back to the inert pre-hydration state. */
export function __resetTableLayoutsForTest(): void {
  for (const timer of pushTimers.values()) clearTimeout(timer);
  pushTimers.clear();
  emit(EMPTY);
}

// ── localStorage bridge ─────────────────────────────────────────────────────
// The SAME key rule DataTable uses (see its `idKey`): company-scoped when a
// company is resolved, byte-identical to the historical key when not. Exported
// so there is one rule rather than two that drift.

export function layoutIdKey(baseIdKey: string, companyId: number | null): string {
  return companyId != null ? `c${companyId}:${baseIdKey}` : baseIdKey;
}

/** The vendored DataGrid's own rule (see its `scopedStorageKey`) — a different
 *  shape from DataTable's, which is exactly why the family prefix exists. */
export function dataGridIdKey(storageKey: string, companyId: number | null): string {
  return companyId != null ? `${storageKey}::c${companyId}` : storageKey;
}

const PARTS = ["order", "hidden", "shown", "widths", "pinned"] as const;

/** Marker holding the layout we last pushed for this table. Its absence means
 *  "never pushed"; a mismatch against localStorage means there are local edits
 *  the server has not seen, which hydration must not overwrite. */
const syncKey = (idKey: string) => `dt:sync:${idKey}`;

/** Local storage identity for a server table key: which family it belongs to,
 *  the key that family reads, and the marker key. */
function localTarget(tableKey: string, companyId: number | null) {
  if (familyOf(tableKey) === "dg") {
    const storageKey = tableKey.slice(DG_PREFIX.length);
    return {
      family: "dg" as const,
      idKey: dataGridIdKey(storageKey, companyId),
      marker: `dt:sync:dg:${dataGridIdKey(storageKey, companyId)}`,
    };
  }
  const idKey = layoutIdKey(tableKey, companyId);
  return { family: "dt" as const, idKey, marker: syncKey(idKey) };
}

function readLocal(tableKey: string, companyId: number | null): StoredLayout {
  const target = localTarget(tableKey, companyId);
  if (target.family === "dg") {
    const grid = readDataGridLayout(target.idKey);
    return {
      ...EMPTY_LAYOUT,
      order: grid.order,
      hidden: grid.hidden,
      widths: grid.widths,
      pinned: grid.pinned,
      groupBy: grid.groupBy,
    };
  }
  const read = <T>(part: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(`dt:${part}:${target.idKey}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };
  return {
    ...EMPTY_LAYOUT,
    order: read<string[]>("order", []),
    hidden: read<string[]>("hidden", []),
    shown: read<string[]>("shown", []),
    widths: read<Record<string, number>>("widths", {}),
    pinned: read<string[]>("pinned", []),
  };
}

function writeLocal(tableKey: string, companyId: number | null, layout: StoredLayout): void {
  const target = localTarget(tableKey, companyId);
  try {
    if (target.family === "dg") {
      /* The grid's own SORT is deliberately preserved: it lives in the same
         stored blob but is working state, not layout, so a layout arriving from
         the account must not silently re-sort the list under the operator. */
      const current = readDataGridLayout(target.idKey);
      writeDataGridLayout(target.idKey, {
        order: layout.order,
        hidden: layout.hidden,
        widths: layout.widths,
        pinned: layout.pinned,
        groupBy: layout.groupBy,
        sort: current.sort,
      });
      return;
    }
    for (const part of PARTS) {
      localStorage.setItem(`dt:${part}:${target.idKey}`, JSON.stringify(layout[part]));
    }
  } catch {
    // quota / privacy mode — the server copy still exists; this browser just
    // won't remember it between visits.
  }
}

export function isEmptyLayout(layout: StoredLayout): boolean {
  return (
    layout.order.length === 0 &&
    layout.hidden.length === 0 &&
    layout.shown.length === 0 &&
    layout.pinned.length === 0 &&
    layout.groupBy.length === 0 &&
    Object.keys(layout.widths).length === 0
  );
}

/** Stable serialisation for the "did this change?" comparisons. Key order is
 *  fixed, and widths are sorted, so two equal layouts never serialise apart.
 *  Exported because DataTable uses the same string to decide whether a render
 *  actually moved the layout or merely re-created the arrays. */
export function serializeLayout(layout: StoredLayout): string {
  const widths: Record<string, number> = {};
  for (const k of Object.keys(layout.widths).sort()) widths[k] = layout.widths[k]!;
  return JSON.stringify({
    order: layout.order,
    hidden: layout.hidden,
    shown: layout.shown,
    widths,
    pinned: layout.pinned,
    groupBy: layout.groupBy,
  });
}

// ── Boot hydration ──────────────────────────────────────────────────────────

interface LayoutsResponse {
  companies?: LayoutCompany[];
  activeCompanyId?: number | null;
  canManageDefaults?: boolean;
  canManageLayouts?: boolean;
  defaults?: Record<string, Record<string, StoredLayout>>;
  defaultNames?: Record<string, Record<string, string>>;
  mine?: Record<string, { layout: StoredLayout; updatedAt: string | null }>;
  myLayouts?: Record<string, Array<{ id: number; name: string; layout: StoredLayout }>>;
}

function normalizeNamed(
  raw: LayoutsResponse["myLayouts"],
): Record<string, NamedLayout[]> {
  const out: Record<string, NamedLayout[]> = {};
  for (const [tableKey, list] of Object.entries(raw ?? {})) {
    if (!Array.isArray(list)) continue;
    out[tableKey] = list
      .filter((l) => l && typeof l.name === "string" && Number.isFinite(Number(l.id)))
      .map((l) => ({ id: Number(l.id), name: l.name, layout: normalize(l.layout) }));
  }
  return out;
}

function normalize(raw: unknown): StoredLayout {
  const r = (raw ?? {}) as Partial<StoredLayout>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const widths: Record<string, number> = {};
  if (r.widths && typeof r.widths === "object") {
    for (const [k, v] of Object.entries(r.widths)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) widths[k] = n;
    }
  }
  return {
    order: list(r.order),
    hidden: list(r.hidden),
    shown: list(r.shown),
    widths,
    pinned: list(r.pinned),
    groupBy: list(r.groupBy),
  };
}

let hydrating: Promise<void> | null = null;

/**
 * Fetch this user's layouts + every company default, once per session.
 *
 * Adoption rule: the server copy wins UNLESS this browser holds edits it never
 * managed to push (localStorage differs from the last-pushed marker) — those
 * are re-pushed instead of being thrown away. A browser that has never pushed
 * has no marker, and the server simply has no row for a table nobody has saved,
 * so today's users lose nothing on first run.
 */
export async function hydrateTableLayouts(): Promise<void> {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    let res: LayoutsResponse;
    try {
      res = await api.get<LayoutsResponse>("/api/table-layouts");
    } catch {
      // Offline / pre-migration / 403. Stay inert: every table keeps using the
      // local prefs it always did.
      hydrating = null;
      return;
    }
    const companyId = getActiveCompanyId();
    let changed = false;
    const repush: Array<[string, StoredLayout]> = [];

    for (const [tableKey, entry] of Object.entries(res.mine ?? {})) {
      const marker = localTarget(tableKey, companyId).marker;
      const server = normalize(entry?.layout);
      const local = readLocal(tableKey, companyId);
      const lastPushed = (() => {
        try {
          return localStorage.getItem(marker);
        } catch {
          return null;
        }
      })();
      const localSerialized = serializeLayout(local);
      if (lastPushed !== null && lastPushed !== localSerialized) {
        // Unpushed local edits — this browser is ahead; send them instead.
        repush.push([tableKey, local]);
        continue;
      }
      if (localSerialized === serializeLayout(server)) continue;
      writeLocal(tableKey, companyId, server);
      try {
        localStorage.setItem(marker, serializeLayout(server));
      } catch {
        /* best effort */
      }
      changed = true;
    }

    emit({
      ready: true,
      companies: Array.isArray(res.companies) ? res.companies : [],
      activeCompanyId: res.activeCompanyId ?? null,
      canManageDefaults: Boolean(res.canManageDefaults),
      canManageLayouts: Boolean(res.canManageLayouts),
      defaultNames: res.defaultNames ?? {},
      myLayouts: normalizeNamed(res.myLayouts),
      defaults: Object.fromEntries(
        Object.entries(res.defaults ?? {}).map(([cid, tables]) => [
          cid,
          Object.fromEntries(
            Object.entries(tables ?? {}).map(([t, l]) => [t, normalize(l)]),
          ),
        ]),
      ),
      // Only bump when stored prefs actually moved: the epoch remounts tables.
      epoch: snapshot.epoch + (changed ? 1 : 0),
    });

    for (const [tableKey, layout] of repush) saveMyLayout(tableKey, layout);
    hydrating = null;
  })();
  return hydrating;
}

// ── Pushing changes up ──────────────────────────────────────────────────────

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PUSH_DELAY_MS = 1200;

/**
 * Mirror a table's layout to the server, debounced per table — a column drag
 * fires a burst of pref writes and only the last one is worth a request.
 *
 * An EMPTY layout is a delete, not an empty row: "I reset this table" and "I
 * never touched it" must read the same on the next machine, or a reset would
 * be undone by the next hydration.
 */
export function saveMyLayout(tableKey: string, layout: StoredLayout): void {
  if (!snapshot.ready) return;
  const existing = pushTimers.get(tableKey);
  if (existing) clearTimeout(existing);
  pushTimers.set(
    tableKey,
    setTimeout(() => {
      pushTimers.delete(tableKey);
      const marker = localTarget(tableKey, getActiveCompanyId()).marker;
      const done = () => {
        try {
          localStorage.setItem(marker, serializeLayout(layout));
        } catch {
          /* best effort */
        }
      };
      const path = `/api/table-layouts/${encodeURIComponent(tableKey)}`;
      const request = isEmptyLayout(layout)
        ? api.del(path)
        : api.put(path, { layout });
      // A failed push leaves the marker stale on purpose: the mismatch is
      // exactly what tells the next hydration this browser is ahead.
      request.then(done).catch(() => {});
    }, PUSH_DELAY_MS),
  );
}

/** Write (or clear, with an empty layout) the ACTIVE company's default view.
 *  Gated to settings.manage server-side; `canManageDefaults` mirrors that. */
export async function saveCompanyDefault(
  baseIdKey: string,
  layout: StoredLayout,
): Promise<void> {
  const path = `/api/table-layouts/${encodeURIComponent(baseIdKey)}/default`;
  const companyId = snapshot.activeCompanyId;
  if (isEmptyLayout(layout)) await api.del(path);
  else await api.put(path, { layout });
  if (companyId == null) return;
  // Reflect it locally so the panel updates without a refetch.
  const cid = String(companyId);
  const tables = { ...(snapshot.defaults[cid] ?? {}) };
  if (isEmptyLayout(layout)) delete tables[baseIdKey];
  else tables[baseIdKey] = layout;
  emit({ ...snapshot, defaults: { ...snapshot.defaults, [cid]: tables } });
}

// ── Named layouts (mig 0239) ────────────────────────────────────────────────
// CRUD on the user's saved column sets. Each call refreshes the snapshot from
// its own response rather than refetching: the boot fetch is a page-load thing,
// and a picker that lags one action behind reads as a failed save.

function putMyLayouts(tableKey: string, list: NamedLayout[]): void {
  emit({
    ...snapshot,
    myLayouts: {
      ...snapshot.myLayouts,
      [tableKey]: [...list].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    },
  });
}

/** Save the given columns as a NEW layout. Duplicating is the same call with
 *  the source's layout — one path, so the two cannot drift. */
export async function createNamedLayout(
  tableKey: string,
  name: string,
  layout: StoredLayout,
): Promise<NamedLayout> {
  const res = await api.post<{ layout: NamedLayout }>(
    `/api/table-layouts/${encodeURIComponent(tableKey)}/layouts`,
    { name, layout },
  );
  const created: NamedLayout = {
    id: Number(res.layout.id),
    name: res.layout.name,
    layout: res.layout.layout,
  };
  putMyLayouts(tableKey, [...(snapshot.myLayouts[tableKey] ?? []), created]);
  return created;
}

export async function renameNamedLayout(
  tableKey: string,
  id: number,
  name: string,
): Promise<void> {
  await api.patch(`/api/table-layouts/${encodeURIComponent(tableKey)}/layouts/${id}`, { name });
  putMyLayouts(
    tableKey,
    (snapshot.myLayouts[tableKey] ?? []).map((l) => (l.id === id ? { ...l, name } : l)),
  );
}

/** Name this company's default — what the whole company inherits. An empty
 *  name clears it, so the picker goes back to naming it after the company. */
export async function renameCompanyDefault(tableKey: string, name: string): Promise<void> {
  await api.patch(`/api/table-layouts/${encodeURIComponent(tableKey)}/default`, { name });
  const cid = snapshot.activeCompanyId;
  if (cid == null) return;
  const key = String(cid);
  const names = { ...(snapshot.defaultNames[key] ?? {}) };
  if (name.trim()) names[tableKey] = name.trim();
  else delete names[tableKey];
  emit({ ...snapshot, defaultNames: { ...snapshot.defaultNames, [key]: names } });
}

export async function deleteNamedLayout(tableKey: string, id: number): Promise<void> {
  await api.del(`/api/table-layouts/${encodeURIComponent(tableKey)}/layouts/${id}`);
  putMyLayouts(
    tableKey,
    (snapshot.myLayouts[tableKey] ?? []).filter((l) => l.id !== id),
  );
}
