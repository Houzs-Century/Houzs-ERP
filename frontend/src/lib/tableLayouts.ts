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

/** The persisted shape of one table's layout. Filters / sort / card-vs-table
 *  are deliberately NOT here: those are working state, not a layout. */
export interface StoredLayout {
  order: string[];
  hidden: string[];
  shown: string[];
  widths: Record<string, number>;
  pinned: string[];
}

export interface LayoutCompany {
  id: number;
  code: string;
  name: string;
}

export interface TableLayoutsSnapshot {
  /** True once the boot fetch has succeeded. Everything below is empty until. */
  ready: boolean;
  companies: LayoutCompany[];
  activeCompanyId: number | null;
  /** May this user write a company-wide default? (settings.manage) */
  canManageDefaults: boolean;
  /** companyId → tableKey → the company's default layout. */
  defaults: Record<string, Record<string, StoredLayout>>;
  /** Bumped whenever hydration changed stored prefs, so a mounted table can
   *  re-read localStorage (it is read once, at mount, by design). */
  epoch: number;
}

const EMPTY: TableLayoutsSnapshot = {
  ready: false,
  companies: [],
  activeCompanyId: null,
  canManageDefaults: false,
  defaults: {},
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

const PARTS = ["order", "hidden", "shown", "widths", "pinned"] as const;

/** Marker holding the layout we last pushed for this table. Its absence means
 *  "never pushed"; a mismatch against localStorage means there are local edits
 *  the server has not seen, which hydration must not overwrite. */
const syncKey = (idKey: string) => `dt:sync:${idKey}`;

function readLocal(idKey: string): StoredLayout {
  const read = <T>(part: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(`dt:${part}:${idKey}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };
  return {
    order: read<string[]>("order", []),
    hidden: read<string[]>("hidden", []),
    shown: read<string[]>("shown", []),
    widths: read<Record<string, number>>("widths", {}),
    pinned: read<string[]>("pinned", []),
  };
}

function writeLocal(idKey: string, layout: StoredLayout): void {
  try {
    for (const part of PARTS) {
      localStorage.setItem(`dt:${part}:${idKey}`, JSON.stringify(layout[part]));
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
  });
}

// ── Boot hydration ──────────────────────────────────────────────────────────

interface LayoutsResponse {
  companies?: LayoutCompany[];
  activeCompanyId?: number | null;
  canManageDefaults?: boolean;
  defaults?: Record<string, Record<string, StoredLayout>>;
  mine?: Record<string, { layout: StoredLayout; updatedAt: string | null }>;
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
      const idKey = layoutIdKey(tableKey, companyId);
      const server = normalize(entry?.layout);
      const local = readLocal(idKey);
      const lastPushed = (() => {
        try {
          return localStorage.getItem(syncKey(idKey));
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
      writeLocal(idKey, server);
      try {
        localStorage.setItem(syncKey(idKey), serializeLayout(server));
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
export function saveMyLayout(baseIdKey: string, layout: StoredLayout): void {
  if (!snapshot.ready) return;
  const existing = pushTimers.get(baseIdKey);
  if (existing) clearTimeout(existing);
  pushTimers.set(
    baseIdKey,
    setTimeout(() => {
      pushTimers.delete(baseIdKey);
      const idKey = layoutIdKey(baseIdKey, getActiveCompanyId());
      const done = () => {
        try {
          localStorage.setItem(syncKey(idKey), serializeLayout(layout));
        } catch {
          /* best effort */
        }
      };
      const path = `/api/table-layouts/${encodeURIComponent(baseIdKey)}`;
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
