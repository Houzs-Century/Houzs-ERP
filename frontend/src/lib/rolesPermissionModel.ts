// Pure model behind the Roles & Permissions matrix.
//
// The redesign's prototype assumed a tidy `module -> resource -> {read, write,
// manage, approve}` grid. Production is a FLAT catalogue of `{ key, resource,
// verb }` (verbs read/create/write/manage/approve), and a role's grants are a
// flat `string[]` of those keys. This module adapts the flat catalogue into the
// grid the UI draws, and holds the staging/diff/guard logic. It is deliberately
// React-free and pure so the behaviour (especially the system-role write
// guards) is unit-tested.

import type { PermissionDef } from "../types";

export type Verb = "read" | "create" | "write" | "manage" | "approve";

// Fixed column order. Every module shows all columns; a (row, verb) with no real
// permission key renders N/A, which is how the grid "degrades where reality
// doesn't fit". `approve` is a real backend verb (scm.so_cancel.approve_l1/l2,
// announcements.approve) — kept last so it never shifts the CRUD columns.
export const VERBS: readonly Verb[] = ["read", "create", "write", "manage", "approve"];

export const VERB_LABEL: Record<Verb, string> = {
  read: "Read",
  create: "Create",
  write: "Write",
  manage: "Manage",
  approve: "Approve",
};

/** One matrix row: a sub-resource "stem" and the real key sitting under each verb. */
export interface PermRow {
  /** Grouping key within the module (key minus its trailing `.verb`). */
  stem: string;
  /** Human row label. */
  label: string;
  /** Mono sub-line under the label (the stem, or the key for single-key rows). */
  sub: string;
  /** verb -> the real permission key that grants it (absent verbs render N/A). */
  keyByVerb: Partial<Record<Verb, string>>;
  /** Every real key in this row (for counts + search). */
  keys: string[];
}

/** One module = one `resource` value from the flat catalogue. */
export interface PermModule {
  id: string;
  label: string;
  rows: PermRow[];
  /** Every real key in the module (for the pill count badge). */
  keys: string[];
}

export type CellState = "on" | "off" | "partial" | "na";

/** roleId -> the staged set of permission keys the role holds. */
export type GrantMap = Record<number, Set<string>>;

function isVerb(v: string): v is Verb {
  return (VERBS as readonly string[]).includes(v);
}

/** Strip a trailing `.<verb>` so `service_cases.read` groups under `service_cases`. */
export function stemOf(key: string, verb: Verb): string {
  const suffix = "." + verb;
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
}

function humanize(stem: string): string {
  const cleaned = stem.replace(/[._]/g, " ").trim();
  if (!cleaned) return stem;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the module -> row -> verb-cell grid from the flat permission catalogue.
 * Resource order is first-seen (the catalogue is already grouped sensibly).
 */
export function buildModules(permissions: PermissionDef[]): PermModule[] {
  const order: string[] = [];
  const byResource = new Map<string, PermissionDef[]>();
  for (const p of permissions) {
    if (p.key === "*") continue; // the wildcard is not a grid cell
    if (!byResource.has(p.resource)) {
      byResource.set(p.resource, []);
      order.push(p.resource);
    }
    byResource.get(p.resource)!.push(p);
  }

  return order.map((resource) => {
    const perms = byResource.get(resource)!;
    const rowByStem = new Map<string, PermRow>();
    const rowOrder: string[] = [];

    for (const p of perms) {
      const verb: Verb = isVerb(p.verb) ? p.verb : "manage";
      const stem = stemOf(p.key, verb);
      if (!rowByStem.has(stem)) {
        rowByStem.set(stem, { stem, label: "", sub: "", keyByVerb: {}, keys: [] });
        rowOrder.push(stem);
      }
      const row = rowByStem.get(stem)!;
      // First key wins a verb slot; a genuine collision keeps both in `keys`.
      if (!row.keyByVerb[verb]) row.keyByVerb[verb] = p.key;
      row.keys.push(p.key);
    }

    const rows = rowOrder.map((stem) => {
      const row = rowByStem.get(stem)!;
      if (row.keys.length === 1) {
        // A one-off grant (e.g. projects.chat): use the catalogue's own label.
        const def = perms.find((p) => p.key === row.keys[0])!;
        row.label = def.label;
        row.sub = def.key;
      } else {
        // A CRUD-shaped sub-resource: name it after the shared stem.
        row.label = humanize(stem);
        row.sub = stem;
      }
      return row;
    });

    return { id: resource, label: resource, rows, keys: perms.map((p) => p.key) };
  });
}

/** True when a role must never be written to: system roles or wildcard holders. */
export function isLockedRole(role: { is_system?: boolean; permissions: string[] }): boolean {
  return !!role.is_system || role.permissions.includes("*");
}

/**
 * The roles a bulk/single edit actually targets: two-or-more checked -> the
 * checked set, else the single selection — then system/locked roles removed.
 * (Guard #1 of the three system-role write guards.)
 */
export function activeIds(
  selected: number | null,
  checked: number[],
  lockedIds: ReadonlySet<number>,
): number[] {
  const base = checked.length >= 2 ? checked : selected != null ? [selected] : [];
  return base.filter((id) => !lockedIds.has(id));
}

/** Add/remove one permission key across target roles, skipping locked ones (guard #2). */
export function setPerm(
  grants: GrantMap,
  roleIds: number[],
  key: string,
  on: boolean,
  lockedIds: ReadonlySet<number>,
): GrantMap {
  const next: GrantMap = { ...grants };
  for (const id of roleIds) {
    if (lockedIds.has(id)) continue;
    const cur = new Set(next[id] ?? []);
    if (on) cur.add(key);
    else cur.delete(key);
    next[id] = cur;
  }
  return next;
}

/** Add/remove many keys across target roles at once (Grant all / Clear all / column toggle). */
export function setPerms(
  grants: GrantMap,
  roleIds: number[],
  keys: string[],
  on: boolean,
  lockedIds: ReadonlySet<number>,
): GrantMap {
  const next: GrantMap = { ...grants };
  for (const id of roleIds) {
    if (lockedIds.has(id)) continue;
    const cur = new Set(next[id] ?? []);
    for (const k of keys) {
      if (on) cur.add(k);
      else cur.delete(k);
    }
    next[id] = cur;
  }
  return next;
}

/** Tri-state of one cell across the active roles. `undefined` key -> structural N/A. */
export function cellState(
  key: string | undefined,
  ids: number[],
  grants: GrantMap,
): CellState {
  if (!key || ids.length === 0) return "na";
  let on = 0;
  for (const id of ids) if ((grants[id] ?? EMPTY).has(key)) on++;
  if (on === 0) return "off";
  if (on === ids.length) return "on";
  return "partial";
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Count of staged grants vs total applicable across the active roles — drives
 * the module pill badge and header meta. Mirrors the prototype: totals sum
 * across roles, so N roles over M keys is N*M.
 */
export function moduleCounts(
  mod: PermModule,
  ids: number[],
  grants: GrantMap,
): { on: number; total: number } {
  let on = 0;
  let total = 0;
  for (const id of ids) {
    total += mod.keys.length;
    const g = grants[id] ?? EMPTY;
    for (const k of mod.keys) if (g.has(k)) on++;
  }
  return { on, total };
}

/**
 * Cell-by-cell diff of staged grants against the last-saved baseline. Returns
 * the total number of changed keys and the ids of the roles that actually
 * changed — so the save bar can say "on {role}" vs "across {n} roles" honestly
 * (the prototype misattributed changes to whatever role was on screen).
 */
export function diffGrants(
  grants: GrantMap,
  baseline: GrantMap,
): { total: number; roleIds: number[] } {
  const ids = new Set<number>();
  for (const k of Object.keys(grants)) ids.add(Number(k));
  for (const k of Object.keys(baseline)) ids.add(Number(k));

  let total = 0;
  const roleIds: number[] = [];
  for (const id of ids) {
    const a = grants[id] ?? EMPTY;
    const b = baseline[id] ?? EMPTY;
    let d = 0;
    for (const k of a) if (!b.has(k)) d++;
    for (const k of b) if (!a.has(k)) d++;
    if (d > 0) {
      total += d;
      roleIds.push(id);
    }
  }
  return { total, roleIds };
}
