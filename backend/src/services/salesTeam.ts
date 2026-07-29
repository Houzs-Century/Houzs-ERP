import type { Env } from "../types";

// ── Code generator ────────────────────────────────────────────
// Format: SR-NNN. Sequence picks up after the highest existing code
// across all-time (no per-year reset since rep population is small).

export async function nextSalesRepCode(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT code FROM sales_reps
       WHERE code LIKE 'SR-%'
       ORDER BY code DESC LIMIT 1`,
  ).first<{ code: string }>();
  let next = 1;
  if (row?.code) {
    const tail = row.code.slice(3);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `SR-${String(next).padStart(3, "0")}`;
}

// ── Cycle check ──────────────────────────────────────────────
// Walk upward from the proposed upline; if we ever land on the rep
// itself, the assignment would create a loop. Used by POST + PATCH
// to refuse a bad upline.

export async function wouldCreateUplineCycle(
  env: Env,
  repId: number,
  proposedUplineId: number,
): Promise<boolean> {
  if (repId === proposedUplineId) return true;
  let cursor: number | null = proposedUplineId;
  const visited = new Set<number>();
  while (cursor != null) {
    if (cursor === repId) return true;
    if (visited.has(cursor)) return true; // pre-existing cycle in data, defensive
    visited.add(cursor);
    const row: { upline_id: number | null } | null = await env.DB.prepare(
      `SELECT upline_id FROM sales_reps WHERE id = ?`,
    )
      .bind(cursor)
      .first<{ upline_id: number | null }>();
    cursor = row?.upline_id ?? null;
  }
  return false;
}

// ── Subtree resolution ───────────────────────────────────────
// Returns the set of rep ids in a rep's downline (inclusive); archived
// reps are pruned together with their whole branch. No callers on main
// today: SCM row-level visibility moved to the users manager_id tree
// (scm/lib/salesScope.ts, PR #245) and the admin-of-subtree PATCH checks
// left with the stripped sales-team admin module. Kept deliberately —
// salesTeamSubtree.test.ts pins the contract.

export async function subtreeRepIds(env: Env, rootRepId: number): Promise<Set<number>> {
  const result = new Set<number>([rootRepId]);
  let frontier: number[] = [rootRepId];
  while (frontier.length) {
    const placeholders = frontier.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id FROM sales_reps WHERE upline_id IN (${placeholders}) AND archived_at IS NULL`,
    )
      .bind(...frontier)
      .all<{ id: number }>();
    const next: number[] = [];
    for (const r of rows.results ?? []) {
      if (!result.has(r.id)) {
        result.add(r.id);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return result;
}

// ── Audit log helper ─────────────────────────────────────────

export async function logSalesTeamActivity(
  env: Env,
  repId: number,
  action: string,
  fromValue: string | null,
  toValue: string | null,
  note: string | null,
  userId?: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_team_activity (rep_id, action, from_value, to_value, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(repId, action, fromValue, toValue, note, userId ?? null)
    .run();
}

// ── User ↔ Sales rep sync ────────────────────────────────────
//
// Keeps the sales_reps roster in lockstep with the users.department:
//   * department = "Sales" and no rep row → auto-create (linked by user_id)
//   * department = "Sales" and rep is archived → un-archive
//   * department ≠ "Sales" and rep exists → soft-archive
//
// Sales-specific attributes (position, upline, commission, brands) stay
// editable in the Sales Team page — only the rep ROW lifecycle is auto-
// managed here. Called from users PATCH after department_id changes.
//
// Department lookup is by NAME (case-insensitive). There's no slug on
// the departments table; the seeded row is canonically "Sales" but prod
// uses "Sales Department", so we match any name CONTAINING 'sales'.

export async function syncSalesRepFromUser(
  env: Env,
  userId: number,
  actorId?: number | null,
): Promise<{ action: "created" | "unarchived" | "archived" | "noop"; repId: number | null }> {
  const user = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, d.name AS dept_name
       FROM users u
  LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{ id: number; name: string | null; email: string; dept_name: string | null }>();
  if (!user) return { action: "noop", repId: null };

  const isSales = (user.dept_name || "").trim().toLowerCase().includes("sales");

  // Existing rep linked to this user (active or archived).
  const existing = await env.DB.prepare(
    `SELECT id, archived_at FROM sales_reps WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: number; archived_at: string | null }>();

  if (isSales) {
    if (!existing) {
      // Auto-create with sensible defaults — boss fills in position /
      // upline / brands / commission from the Sales Team page later.
      const code = await nextSalesRepCode(env);
      const r = await env.DB.prepare(
        `INSERT INTO sales_reps (code, name, email, user_id, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
        .bind(code, user.name || user.email, user.email || null, userId)
        .run();
      const repId = r.meta.last_row_id as number;
      await logSalesTeamActivity(
        env,
        repId,
        "created",
        null,
        code,
        "Auto-created from Team (department set to Sales)",
        actorId ?? null,
      );
      return { action: "created", repId };
    }
    if (existing.archived_at) {
      // Restore — they're back in Sales.
      await env.DB.prepare(
        `UPDATE sales_reps
            SET archived_at = NULL, archived_by = NULL, status = 'active',
                updated_at = datetime('now')
          WHERE id = ?`,
      )
        .bind(existing.id)
        .run();
      await logSalesTeamActivity(
        env,
        existing.id,
        "status_change",
        "archived",
        "active",
        "Auto-restored from Team (department set to Sales)",
        actorId ?? null,
      );
      return { action: "unarchived", repId: existing.id };
    }
    return { action: "noop", repId: existing.id };
  }

  // Not in Sales — archive any live rep row.
  if (existing && !existing.archived_at) {
    await env.DB.prepare(
      `UPDATE sales_reps
          SET archived_at = datetime('now'), archived_by = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(actorId ?? null, existing.id)
      .run();
    await logSalesTeamActivity(
      env,
      existing.id,
      "status_change",
      "active",
      "archived",
      "Auto-archived from Team (department removed from Sales)",
      actorId ?? null,
    );
    return { action: "archived", repId: existing.id };
  }
  return { action: "noop", repId: existing?.id ?? null };
}

// ── Lazy backfill ────────────────────────────────────────────
//
// Self-healing pass for the Sales Team list. The per-PATCH sync hook
// above only fires when an admin changes a user's department after
// this code shipped — users who were already in Sales before don't
// get a rep row until something pokes them. Call this at the top of
// the list endpoint so opening Sales Team is enough to converge.
//
// Cheap when there's no drift: one indexed LEFT JOIN with LIMIT 1
// returns nothing and we exit. When there IS drift, runs the same
// syncSalesRepFromUser used by the PATCH hook so the audit trail
// looks identical regardless of which path created the rep.

export async function autoBackfillSalesReps(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT u.id
       FROM users u
       JOIN departments d ON d.id = u.department_id
  LEFT JOIN sales_reps r ON r.user_id = u.id
      WHERE LOWER(d.name) LIKE '%sales%'
        AND r.id IS NULL`,
  ).all<{ id: number }>();
  const missing = rows.results ?? [];
  for (const row of missing) {
    await syncSalesRepFromUser(env, row.id, null);
  }
  return missing.length;
}
