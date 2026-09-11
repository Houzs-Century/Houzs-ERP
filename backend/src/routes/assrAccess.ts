import type { Context, Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { notifyServiceCaseResponsible } from "../services/assrNotify";

/**
 * Access list (Nth-person visibility) endpoints, mounted onto the ASSR app.
 *
 * Lives in its own module (not inline in routes/assr.ts) purely so the 12k-line
 * route file does not grow past the file-size ceiling — the routes still register
 * on the SAME Hono instance and the SAME `/api/assr` mount. `caseInCallerScope`
 * is passed in because it is a routes/assr.ts-local guard (company + row scope,
 * 404 out of scope).
 *
 * Grant / revoke row visibility for staff who are NEITHER the salesperson
 * (sales_agent) NOR one of the two assigned_to slots - the open-ended reach ops
 * needs when a case must stay attributed to its original rep while several other
 * people work it (owner 2026-09-09). Gated at service_cases.write, the same tier
 * as Assign, so a read-only sales rep cannot grant. Visibility reads
 * assr_case_access as a 6th additive OR-arm inside assrVisibilityPredicateSql
 * (mig 20260911T1600) - see docs/modules/service-case.md section 6.
 */
export function registerAssrAccessRoutes(
  app: Hono<{ Bindings: Env }>,
  caseInCallerScope: (c: Context<{ Bindings: Env }>, id: number) => Promise<boolean>,
): void {
  app.post("/:id{[0-9]+}/access", requirePermission("service_cases.write"), async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const userId = (c as any).get?.("userId") ?? null;
    const body = await c.req
      .json<{ user_id?: number }>()
      .catch(() => ({}) as { user_id?: number });
    const grantee = Number(body.user_id);
    if (!Number.isInteger(grantee) || grantee <= 0) {
      return c.json({ error: "user_id required" }, 400);
    }
    // Must be a case the caller can already see (company + row scope). Out-of-scope
    // -> 404, so a grant can never target a case across the visibility boundary.
    if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
    const granteeRow = await c.env.DB.prepare(
      `SELECT name FROM users WHERE id = ? LIMIT 1`,
    )
      .bind(grantee)
      .first<{ name: string | null }>();
    if (!granteeRow) return c.json({ error: "User not found" }, 404);
    // Idempotent: a repeat grant is a no-op and must not re-notify. Check-then-
    // insert (internal ERP, no meaningful race) keeps the notify path single-fire.
    const already = await c.env.DB.prepare(
      `SELECT 1 FROM assr_case_access WHERE assr_id = ? AND user_id = ? LIMIT 1`,
    )
      .bind(id, grantee)
      .first();
    if (already) return c.json({ ok: true, already: true });
    await c.env.DB.prepare(
      `INSERT INTO assr_case_access (assr_id, user_id, added_by, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
      .bind(id, grantee, userId)
      .run();
    // company-scope: caseInCallerScope(c, id) above already proved company + row
    // scope (404 out of scope), so this read can only reach a case this caller
    // owns. It only builds the notify payload.
    const caseRow = await c.env.DB.prepare(
      `SELECT assr_no, customer_name FROM assr_cases WHERE id = ?`,
    )
      .bind(id)
      .first<{ assr_no: string | null; customer_name: string | null }>();
    await c.env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
       VALUES (?, 'access_grant', NULL, ?, ?, ?)`,
    )
      .bind(id, String(grantee), (granteeRow.name ?? "").trim() || null, userId)
      .run();
    // Same responsible-change notice as Assign (best-effort - never throws): tell
    // the granted user + their upline they can now reach this case.
    await notifyServiceCaseResponsible(c.env, {
      reason: "reassigned",
      assrNo: caseRow?.assr_no ?? null,
      customerName: caseRow?.customer_name ?? null,
      userIds: [grantee],
    });
    return c.json({ ok: true });
  });

  app.delete(
    "/:id{[0-9]+}/access/:userId{[0-9]+}",
    requirePermission("service_cases.write"),
    async (c) => {
      const id = parseInt(c.req.param("id"), 10);
      const uid = parseInt(c.req.param("userId"), 10);
      if (isNaN(id) || isNaN(uid)) return c.json({ error: "Invalid ID" }, 400);
      const actorId = (c as any).get?.("userId") ?? null;
      if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
      const res = await c.env.DB.prepare(
        `DELETE FROM assr_case_access WHERE assr_id = ? AND user_id = ?`,
      )
        .bind(id, uid)
        .run();
      // Only log a revoke that actually removed a grant, so replaying a stale
      // delete doesn't post a phantom timeline entry.
      if (Number(res.meta?.changes ?? res.meta?.rows_written ?? 0) > 0) {
        await c.env.DB.prepare(
          `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
           VALUES (?, 'access_revoke', ?, NULL, NULL, ?)`,
        )
          .bind(id, String(uid), actorId)
          .run();
      }
      return c.json({ ok: true });
    },
  );
}
