// Pure model behind the Roles × Module access matrix (RBAC rebuild, Option A —
// PR2). React-free and unit-tested so the two things that must never silently
// drift — the level→page-level mapping and the level→permission-key mapping —
// are provable in isolation.
//
// THE OWNER'S MENTAL MODEL. One role = what it may DO (flat permission keys) +
// what it may SEE (role_page_access rows). The matrix collapses both onto ONE
// control per module: a level 无/看/改/批 (none/view/edit/full). Finer control
// expands a module into its sub-page rows (each its own level).
//
// THE SAFETY RULE (do not weaken). A coarse level NEVER auto-grants an approval
// or money-moving key. `isNeverByLevel` excludes every `*.approve*` key and every
// fine-grained SCM key (all `scm.*` except the coarse `scm.access` umbrella), so
// 批 (full) on a module grants that module's read/create/write/manage CRUD keys
// but never SO-cancel L1/L2, amendment price/line/delivery, payment check/approve,
// HR close/reopen, etc. Those keep their explicit-grant semantics and stay in the
// Roles tab. The matrix's SCM modules drive PAGE visibility (+ the scm.access
// umbrella); the fine SCM write gates are not the matrix's to toss around.

import type { PermissionDef } from "../types";

export type MatrixLevel = "none" | "view" | "edit" | "full";

/** Writable levels, lowest → highest. */
export const MATRIX_LEVELS: readonly MatrixLevel[] = ["none", "view", "edit", "full"] as const;

/** Chinese labels the owner sees (business-first per CLAUDE.md). */
export const MATRIX_LEVEL_LABEL: Record<MatrixLevel, string> = {
  none: "无",
  view: "看",
  edit: "改",
  full: "批",
};

/** English sub-label for the dropdown / tooltip. */
export const MATRIX_LEVEL_LABEL_EN: Record<MatrixLevel, string> = {
  none: "None",
  view: "View",
  edit: "Edit",
  full: "Full",
};

export function levelRank(level: MatrixLevel): number {
  return MATRIX_LEVELS.indexOf(level);
}

export function maxLevel(a: MatrixLevel, b: MatrixLevel): MatrixLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

/** A page catalogue entry as served by GET /api/roles/page-access. */
export interface PageLite {
  key: string;
  label: string;
  parent: string | null;
  dormant?: boolean;
}

/**
 * A role_page_access level as STORED can be legacy 3-level (none/partial/full,
 * written by the old role matrix + PR1's no-op seed) or 4-level
 * (none/view/edit/full). Collapse to the 4-level matrix vocabulary — `partial`
 * ranks as `view` (same access, ACCESS_RANK 1), so re-saving a partial row as
 * `view` is a no-op for login resolution.
 */
export function normalizeStoredLevel(level: string | undefined | null): MatrixLevel {
  switch (level) {
    case "full":
      return "full";
    case "edit":
      return "edit";
    case "view":
    case "partial":
      return "view";
    default:
      return "none";
  }
}

/**
 * Keys a coarse module level must NEVER auto-grant. Approval keys (the owner's
 * "审批显式授予" rule — `*.approve`, `*.approve_l1/l2`, `*.approve_lines` …) and
 * every fine-grained SCM key (money / write / attribution — all `scm.*` except
 * the coarse `scm.access` umbrella). These are edited explicitly in the Roles
 * tab, never flipped by a module dropdown.
 */
export function isNeverByLevel(key: string): boolean {
  if (key.includes(".approve")) return true;
  if (key.startsWith("scm.") && key !== "scm.access") return true;
  return false;
}

/** The SCM umbrella permission — granted when any SCM area is >= view so the
 *  coarse /api/scm gate matches the page visibility the matrix just set. */
export const SCM_ACCESS_KEY = "scm.access";

/**
 * Page keys whose level is always DERIVED from their children rather than set
 * directly. Only the bare `scm` umbrella: its area children (scm.sales, …) are
 * the editable module tops, and `scm` itself is consulted by the resolver only
 * for an area with no explicit row (which never happens — the matrix sends every
 * area). Kept = max(area levels) so a direct gate on bare `scm` is never lower
 * than any area the role can reach.
 */
export const PARENT_DERIVED_KEYS: readonly string[] = ["scm"] as const;

interface ModuleSpec {
  id: string;
  labelZh: string;
  labelEn: string;
  /** A page belongs to this module when its key equals, or starts with
   *  `<prefix>.`, any of these. Order matters: first spec to claim a page wins. */
  pagePrefixes: string[];
  /** Permission `resource` values whose CRUD keys this module's level drives. */
  resources: string[];
  /** SCM area: pages + the scm.access umbrella only; fine SCM keys stay explicit. */
  scmArea?: boolean;
}

// The owner-facing module list (plan §模块与级别). HR is deliberately absent: it
// has no page key and its only permissions are scm.hr.* (all isNeverByLevel), so
// a matrix cell for it would control nothing — it stays in the Roles tab.
const MODULE_SPECS: ModuleSpec[] = [
  { id: "service_cases", labelZh: "售后", labelEn: "Service Cases", pagePrefixes: ["service_cases"], resources: ["Service Cases"] },
  { id: "projects", labelZh: "项目", labelEn: "Projects", pagePrefixes: ["projects"], resources: ["Projects"] },
  { id: "sales", labelZh: "销售录入", labelEn: "Sales Entries", pagePrefixes: ["sales"], resources: ["Sales Entries"] },
  { id: "scm.sales", labelZh: "供应链·销售", labelEn: "SCM · Sales", pagePrefixes: ["scm.sales"], resources: [], scmArea: true },
  { id: "scm.consignment", labelZh: "供应链·寄售", labelEn: "SCM · Consignment", pagePrefixes: ["scm.consignment"], resources: [], scmArea: true },
  { id: "scm.procurement", labelZh: "供应链·采购", labelEn: "SCM · Procurement", pagePrefixes: ["scm.procurement"], resources: [], scmArea: true },
  { id: "scm.transportation", labelZh: "供应链·运输", labelEn: "SCM · Transport", pagePrefixes: ["scm.transportation"], resources: [], scmArea: true },
  { id: "scm.warehouse", labelZh: "供应链·仓库", labelEn: "SCM · Warehouse", pagePrefixes: ["scm.warehouse"], resources: [], scmArea: true },
  { id: "scm.finance", labelZh: "供应链·财务", labelEn: "SCM · Finance", pagePrefixes: ["scm.finance"], resources: [], scmArea: true },
  { id: "mail", labelZh: "邮件", labelEn: "Mail Center", pagePrefixes: [], resources: ["Mail Center"] },
  { id: "announcements", labelZh: "公告", labelEn: "Announcements", pagePrefixes: [], resources: ["Announcements", "Memos"] },
  { id: "fleet", labelZh: "车队", labelEn: "Fleet", pagePrefixes: [], resources: ["Fleet Maintenance"] },
  { id: "pos", labelZh: "POS", labelEn: "POS", pagePrefixes: [], resources: ["POS Admin"] },
  { id: "team", labelZh: "团队与角色", labelEn: "Team & Roles", pagePrefixes: ["team"], resources: ["Team", "Roles"] },
  { id: "system", labelZh: "系统 / IT", labelEn: "System / IT", pagePrefixes: ["settings", "system_health"], resources: ["Settings", "IT", "Activity Log", "Custom Fields"] },
];

/** CRUD permission keys of a module, split by tier, with never-by-level keys and
 *  the approve verb removed (so a level never grants an approval/money key). */
export interface ModulePermKeys {
  read: string[];
  write: string[];
  manage: string[];
}

export interface MatrixModule {
  id: string;
  labelZh: string;
  labelEn: string;
  scmArea: boolean;
  /** Pages this module governs, catalogue order, parents before children. */
  pages: PageLite[];
  /** The module's "top" page key (shallowest), or null for a page-less module. */
  topPageKey: string | null;
  perm: ModulePermKeys;
}

function pageMatchesPrefix(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(prefix + ".");
}

function specForPage(key: string): ModuleSpec | null {
  // Most specific (longest prefix) wins, so scm.sales beats a hypothetical scm.
  let best: { spec: ModuleSpec; len: number } | null = null;
  for (const spec of MODULE_SPECS) {
    for (const p of spec.pagePrefixes) {
      if (pageMatchesPrefix(key, p) && (!best || p.length > best.len)) {
        best = { spec, len: p.length };
      }
    }
  }
  return best?.spec ?? null;
}

function tierKeys(permissions: PermissionDef[], resources: string[]): ModulePermKeys {
  const inModule = permissions.filter(
    (p) => p.key !== "*" && resources.includes(p.resource) && !isNeverByLevel(p.key),
  );
  return {
    read: inModule.filter((p) => p.verb === "read").map((p) => p.key),
    write: inModule.filter((p) => p.verb === "create" || p.verb === "write").map((p) => p.key),
    manage: inModule.filter((p) => p.verb === "manage").map((p) => p.key),
  };
}

/**
 * Group the served pages + permission catalogue into the owner's modules. Pages
 * that match no spec (only the bare `scm` umbrella today — a PARENT_DERIVED key)
 * are left out of visible rows; the save step still sends them, derived.
 */
export function buildMatrixModules(
  pages: PageLite[],
  permissions: PermissionDef[],
): MatrixModule[] {
  const byModule = new Map<string, PageLite[]>();
  for (const page of pages) {
    if (PARENT_DERIVED_KEYS.includes(page.key)) continue; // derived, not an own row
    const spec = specForPage(page.key);
    if (!spec) continue;
    const list = byModule.get(spec.id) ?? [];
    list.push(page);
    byModule.set(spec.id, list);
  }

  return MODULE_SPECS.map((spec) => {
    const modPages = byModule.get(spec.id) ?? [];
    // The top page = the one with no parent inside this module (shallowest key).
    const top = modPages.find((p) => !p.parent) ?? modPages.at(0) ?? null;
    return {
      id: spec.id,
      labelZh: spec.labelZh,
      labelEn: spec.labelEn,
      scmArea: !!spec.scmArea,
      pages: modPages,
      topPageKey: top?.key ?? null,
      perm: tierKeys(permissions, spec.resources),
    };
  }).filter((m) => m.pages.length > 0 || m.perm.read.length + m.perm.write.length + m.perm.manage.length > 0);
}

/** Every real permission key a module's LEVEL may touch (for the save diff). */
export function moduleLeveledKeys(m: MatrixModule): string[] {
  return [...m.perm.read, ...m.perm.write, ...m.perm.manage];
}

/** The permission keys a given level grants, within one module (never-by-level
 *  keys already excluded from the tiers). Lower levels are subsets of higher. */
export function keysGrantedAtLevel(m: MatrixModule, level: MatrixLevel): Set<string> {
  const out = new Set<string>();
  if (level === "none") return out;
  for (const k of m.perm.read) out.add(k);
  if (level === "view") return out;
  for (const k of m.perm.write) out.add(k);
  if (level === "edit") return out;
  for (const k of m.perm.manage) out.add(k);
  return out;
}

/**
 * Apply a module level to a staged permission set: grant that level's keys,
 * remove the module's higher-tier keys. Never-by-level keys are untouched
 * (they are not in the module's tiers). Returns a NEW set.
 */
export function applyLevelToPerms(
  perms: ReadonlySet<string>,
  m: MatrixModule,
  level: MatrixLevel,
): Set<string> {
  const granted = keysGrantedAtLevel(m, level);
  const next = new Set(perms);
  for (const k of moduleLeveledKeys(m)) {
    if (granted.has(k)) next.add(k);
    else next.delete(k);
  }
  return next;
}

/**
 * The level to SHOW for a module. A page-bearing module reads its common page
 * level ("mixed" when sub-pages diverge). A page-less module (mail / POS / fleet
 * / announcements) derives from the permission set: the highest tier present.
 */
export function moduleLevel(
  m: MatrixModule,
  pageLevels: Readonly<Record<string, MatrixLevel>>,
  perms: ReadonlySet<string>,
): MatrixLevel | "mixed" {
  if (m.pages.length > 0) {
    let common: MatrixLevel | null = null;
    for (const p of m.pages) {
      const lv = pageLevels[p.key] ?? "none";
      if (common === null) common = lv;
      else if (common !== lv) return "mixed";
    }
    return common ?? "none";
  }
  // Page-less: highest tier whose keys are all present.
  if (m.perm.manage.length > 0 && m.perm.manage.every((k) => perms.has(k))) return "full";
  if (m.perm.write.length > 0 && m.perm.write.every((k) => perms.has(k))) return "edit";
  if (m.perm.read.length > 0 && m.perm.read.every((k) => perms.has(k))) return "view";
  return "none";
}

/**
 * Set every (non-dormant) page of a module to `level`. Dormant pages keep their
 * current value — they are read by nothing and the matrix greys them. Returns a
 * NEW pageLevels map.
 */
export function applyLevelToPages(
  pageLevels: Readonly<Record<string, MatrixLevel>>,
  m: MatrixModule,
  level: MatrixLevel,
): Record<string, MatrixLevel> {
  const next = { ...pageLevels };
  for (const p of m.pages) {
    if (p.dormant) continue;
    next[p.key] = level;
  }
  return next;
}

/**
 * The final set of page rows to persist (replace-set body). Starts from the
 * staged per-page levels for every served page, then forces each
 * PARENT_DERIVED key to max(its direct children). Dormant pages are included at
 * their current level so the role keeps a complete row set (hasRows stays true).
 */
export function pageRowsToSend(
  pages: PageLite[],
  pageLevels: Readonly<Record<string, MatrixLevel>>,
): Array<{ pageKey: string; level: MatrixLevel }> {
  const level: Record<string, MatrixLevel> = {};
  for (const p of pages) level[p.key] = pageLevels[p.key] ?? "none";

  for (const parent of PARENT_DERIVED_KEYS) {
    if (!(parent in level)) continue;
    let derived: MatrixLevel = "none";
    for (const p of pages) {
      if (p.parent === parent) derived = maxLevel(derived, level[p.key]);
    }
    level[parent] = derived;
  }

  return pages.map((p) => ({ pageKey: p.key, level: level[p.key] }));
}

/**
 * Reconcile the scm.access umbrella against the staged SCM page levels: present
 * when any SCM area is >= view, absent when every SCM area is none. Keeps the
 * coarse /api/scm gate consistent with the per-area visibility the matrix set.
 * Returns a NEW set.
 */
export function reconcileScmAccess(
  perms: ReadonlySet<string>,
  pageLevels: Readonly<Record<string, MatrixLevel>>,
): Set<string> {
  let active = false;
  for (const [key, lv] of Object.entries(pageLevels)) {
    if (key.startsWith("scm.") && levelRank(lv) >= levelRank("view")) {
      active = true;
      break;
    }
  }
  const next = new Set(perms);
  if (active) next.add(SCM_ACCESS_KEY);
  else next.delete(SCM_ACCESS_KEY);
  return next;
}

/** Symmetric difference count of two permission sets (for the dirty/save bar). */
export function permsDiffer(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return true;
  for (const k of a) if (!b.has(k)) return true;
  return false;
}

/** Count of pages whose staged level differs from the baseline. */
export function pageLevelsDiffCount(
  pages: PageLite[],
  staged: Readonly<Record<string, MatrixLevel>>,
  baseline: Readonly<Record<string, MatrixLevel>>,
): number {
  let n = 0;
  for (const p of pages) {
    if ((staged[p.key] ?? "none") !== (baseline[p.key] ?? "none")) n++;
  }
  return n;
}
