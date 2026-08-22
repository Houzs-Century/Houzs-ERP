// ----------------------------------------------------------------------------
// positionPageOverrides — owner-editable SCM module access per POSITION.
//
// Owner ruling 2026-08-22 ("roles & permission 还需要添加其他 module — 全部 scm
// 模块"): the Roles & Permissions matrix governs SCM page access too. The
// code-defined position policy (services/positionPolicy.ts) stays the
// BASELINE; rows in `position_page_overrides` (PG mig 0323 / D1 151) are
// deltas the owner sets in the matrix, applied over the resolved policy at
// session hydration.
//
// Scope and safety:
//   * Valid targets are the SCM LEAF keys of the page catalogue — the exact
//     keys `scmAreaGuard` reads from `user.page_access` (a direct lookup, no
//     cascade), so a stored override IS the enforced level. L1 area keys and
//     non-scm keys are refused: an override must name what the guard names.
//   * `*` (god positions) bypasses the guard entirely — overrides never apply.
//   * The sales-JD deny/write-cap and the money-write rule run BEFORE the map
//     inside the guard, so an override can never WIDEN past a code rule; it
//     can only move within what those rules already allow.
//   * A position with any override becomes scm_l2_configured at hydration so
//     the guard enforces its map. For a default-full position the map is the
//     full-access map with the overridden keys replaced — nothing else
//     narrows, so there is no accidental-lockout surface.
// ----------------------------------------------------------------------------

import type { Env } from "../types";
import { PAGES, POSITION_ACCESS_LEVELS, type AccessLevel } from "./pageAccess";

/** Levels an override may carry — the POSITION 4-level vocabulary, imported
 *  from its one home (`partial` is a role-matrix concept and is not in it). */
export const OVERRIDE_LEVELS = POSITION_ACCESS_LEVELS;
export type OverrideLevel = "none" | "view" | "edit" | "full";

export function isValidOverrideLevel(level: string): level is OverrideLevel {
  return (OVERRIDE_LEVELS as readonly string[]).includes(level);
}

/** SCM leaf keys — every catalogue key under "scm." that no other scm key
 *  names as its parent. Derived, not hand-listed, so a new SCM page joins the
 *  matrix by existing in the catalogue. */
export const SCM_OVERRIDE_KEYS: readonly string[] = (() => {
  const scmKeys = PAGES.filter((p) => p.key.startsWith("scm.")).map((p) => p.key);
  const parents = new Set(
    PAGES.filter((p) => p.key.startsWith("scm.") && p.parent).map((p) => p.parent as string),
  );
  return scmKeys.filter((k) => !parents.has(k)).sort();
})();

const KEY_SET = new Set(SCM_OVERRIDE_KEYS);

export function isValidOverrideKey(key: string): boolean {
  return KEY_SET.has(key);
}

export interface PageOverrideRow {
  page_key: string;
  level: OverrideLevel;
}

/** The overrides stored for one position. Empty array = pure policy baseline. */
export async function loadPositionPageOverrides(
  env: Env,
  positionId: number,
): Promise<PageOverrideRow[]> {
  const rows = await env.DB.prepare(
    `SELECT page_key, level FROM position_page_overrides WHERE position_id = ? ORDER BY page_key`,
  )
    .bind(positionId)
    .all<PageOverrideRow>();
  return rows.results.filter(
    (r) => isValidOverrideKey(r.page_key) && isValidOverrideLevel(r.level),
  );
}

/** Apply overrides onto a resolved page-access map. Pure; returns the same
 *  reference when there is nothing to apply so hydration can cheaply detect
 *  "no change". */
export function applyPageOverrides(
  map: Record<string, AccessLevel>,
  overrides: readonly PageOverrideRow[],
): Record<string, AccessLevel> {
  if (overrides.length === 0) return map;
  const next: Record<string, AccessLevel> = { ...map };
  for (const o of overrides) next[o.page_key] = o.level;
  return next;
}
