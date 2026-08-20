// ─────────────────────────────────────────────────────────────────────────
// orgScope.ts — full-chain reporting-line visibility (owner spec, 2026-07).
//
// "A reports to B, B reports to C → C sees B's AND A's records": the caller
// plus their ENTIRE subtree in the public.users.manager_id tree, any depth.
// This is the SO / Service Case scoping rule (full downline chain). It is
// unrelated to project visibility, which is no longer PIC/brand-scoped at all
// (the one-hop projectAcl rule was removed 2026-08-19).
//
// Implementation: iterative breadth-first expansion over users.manager_id
// (works identically on the D1 shim and Postgres — no WITH RECURSIVE
// portability concerns), with a visited-set cycle guard and a hard depth
// cap so a manager_id loop in the data can never hang a request.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";

/** Hard ceiling on reporting-chain depth. Real org charts are < 10 deep;
 *  the cap only exists to bound a pathological manager_id cycle. */
const MAX_CHAIN_DEPTH = 10;

/**
 * The caller's own id plus every user under them in the manager_id tree
 * (direct reports, their reports, … any depth up to MAX_CHAIN_DEPTH).
 * Includes disabled/archived users so their historical records stay
 * visible to their (former) manager.
 */
export async function subtreeUserIds(
  env: Env,
  rootUserId: number,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<number[]> {
  const seen = new Set<number>([Number(rootUserId)]);
  let frontier: number[] = [Number(rootUserId)];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const placeholders = frontier.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id FROM users WHERE manager_id IN (${placeholders})`,
    )
      .bind(...frontier)
      .all<{ id: number }>();
    const next: number[] = [];
    for (const r of rows.results ?? []) {
      const id = Number(r.id);
      if (!Number.isFinite(id)) continue;
      if (!seen.has(id)) {
        seen.add(id); // visited-set doubles as the cycle guard
        next.push(id);
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * The caller's own id plus every user ABOVE them in the manager_id chain
 * (their manager, their manager's manager, … up to the root or
 * MAX_CHAIN_DEPTH). This is the INVERSE of subtreeUserIds — it walks UP the
 * reporting line, not down. Used to notify the pyramid: when a service case
 * lands on a salesperson, that person AND everyone they report to (recursively)
 * gets the in-app notice (owner "reporting-to = FULL recursive visibility").
 * Cycle-guarded via a visited set; disabled/archived managers stay in the chain
 * so an escalation still reaches them.
 */
export async function uplineUserIds(
  env: Env,
  leafUserId: number,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<number[]> {
  const start = Number(leafUserId);
  if (!Number.isFinite(start)) return [];
  const seen = new Set<number>([start]);
  let currentId: number | null = start;
  for (let depth = 0; depth < maxDepth && currentId != null; depth++) {
    const row: { manager_id: number | null } | null = await env.DB.prepare(
      `SELECT manager_id FROM users WHERE id = ?`,
    )
      .bind(currentId)
      .first<{ manager_id: number | null }>();
    const managerId: number = Number(row?.manager_id ?? NaN);
    if (!Number.isFinite(managerId)) break; // reached the root (no manager)
    if (seen.has(managerId)) break; // cycle guard
    seen.add(managerId);
    currentId = managerId;
  }
  return [...seen];
}

/** One ancestor in a reporting chain, with its DISTANCE from the leaf. */
export interface UplineStep {
  userId: number;
  /** 1 = the leaf's direct manager, 2 = that manager's manager, … */
  level: number;
}

/**
 * The ORDERED manager chain above `leafUserId`, each ancestor tagged with its
 * distance. The leaf itself is NOT included (it is distance 0, and the HR
 * commission chain override must never pay someone an override on their own
 * sale — they already earn personal commission on it).
 *
 * WHY THIS EXISTS ALONGSIDE uplineUserIds: that function answers "who should be
 * notified" and returns a Set-derived, self-inclusive, UNORDERED-by-contract
 * list. Chain-override payroll needs the LEVEL of each ancestor, and must not
 * depend on JS Set insertion order to decide what someone is paid. Its
 * behaviour is deliberately left untouched — services/assrNotify.ts is a live
 * caller.
 *
 * `maxDepth` is a CYCLE bound, not a policy cap: the HR caller passes the
 * deepest level the owner has actually configured, so "unlimited depth" means
 * "as deep as you configure" rather than a constant hidden in this file. The
 * visited set still guarantees termination on a manager_id loop regardless.
 */
export async function uplineChainSteps(
  env: Env,
  leafUserId: number,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<UplineStep[]> {
  const start = Number(leafUserId);
  if (!Number.isFinite(start)) return [];
  const seen = new Set<number>([start]);
  const steps: UplineStep[] = [];
  let currentId: number | null = start;
  for (let depth = 1; depth <= maxDepth && currentId != null; depth++) {
    const row: { manager_id: number | null } | null = await env.DB.prepare(
      `SELECT manager_id FROM users WHERE id = ?`,
    )
      .bind(currentId)
      .first<{ manager_id: number | null }>();
    const managerId: number = Number(row?.manager_id ?? NaN);
    if (!Number.isFinite(managerId)) break; // reached the root (no manager)
    if (seen.has(managerId)) break; // cycle guard — also stops self-management
    seen.add(managerId);
    steps.push({ userId: managerId, level: depth });
    currentId = managerId;
  }
  return steps;
}

/**
 * The lowercased, trimmed display NAMES of the caller's reporting subtree
 * (self + full manager_id downline). Used to reach LEGACY service cases that
 * carry only a free-text `sales_agent` NAME (mirrored from AutoCount) and no
 * created_by / assigned_to id linkage: matching that text against these names
 * lets the salesperson — and, per the pyramid rule, everyone above them — see
 * their own old cases without any data backfill. Empty names are dropped;
 * result is de-duplicated. Reuses subtreeUserIds so the id-scope and the
 * name-scope can never resolve to different people.
 */
export async function subtreeAgentNames(
  env: Env,
  rootUserId: number,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<string[]> {
  const ids = await subtreeUserIds(env, rootUserId, maxDepth);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT name FROM users WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ name: string | null }>();
  const names = new Set<string>();
  for (const r of rows.results ?? []) {
    const n = (r.name ?? "").trim().toLowerCase();
    if (n) names.add(n);
  }
  return [...names];
}

/**
 * Restrict `project_sales_reports` rows to the ones a non-director sales user
 * may see: their OWN sale-amount entries plus their downline's (owner spec
 * 2026-07). Rep identity on a sales-report row is `uploaded_by` — the users.id
 * of the rep who logged the sale (see createSalesReport) — which maps directly
 * onto the users.manager_id subtree that subtreeUserIds() returns, so no extra
 * join is needed.
 *
 * `canSeeAll` short-circuits for directors / service-case managers (`*`,
 * Super Admin / Sales Director / Finance Manager, or service_cases.manage) —
 * they keep the full list unchanged. For everyone else, rows whose rep can't
 * be resolved (null uploaded_by) are dropped: fail closed on financial data.
 * Reuses subtreeUserIds — the same downline resolver SO / Service Cases use.
 */
export async function scopeSalesReportsForUser<
  T extends { uploaded_by?: number | null },
>(
  env: Env,
  userId: number | null | undefined,
  rows: T[],
  canSeeAll: boolean,
): Promise<T[]> {
  if (canSeeAll) return rows;
  if (userId == null) return []; // fail closed, never open
  const visible = new Set(await subtreeUserIds(env, Number(userId)));
  return rows.filter(
    (r) => r.uploaded_by != null && visible.has(Number(r.uploaded_by)),
  );
}
