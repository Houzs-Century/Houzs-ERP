// ── Supplier factory returns (返厂) ─────────────────────────────
//
// Owner 2026-09-21 "我需要2次返厂 Service 功能 / 可以自己添加多少次都可以". The
// supplier leg (stage pending_supplier_pickup) is a factory round-trip whose
// dates lived as single columns on assr_cases (supplier_pickup_at out,
// items_ready_at back), so a second trip overwrote the first — and a real case
// has been back FOUR times. Each trip is now a row in assr_supplier_returns
// (round_no 1..N, added freely). This table is the SOURCE OF TRUTH for the trip
// dates; the two columns on assr_cases MIRROR the current (highest round_no) row
// so the Delivery board and the HC Delivery sheet keep reading the trip in
// progress. Both surfaces render this list via the shared helper
// vendor/scm/lib/assr/returns.ts.
//
// Split out of services/assr.ts to keep that file under its size ceiling; it
// imports transitionStage + logActivity from there (one direction — assr.ts
// only imports listSupplierReturns back, both used at runtime, no init cycle).
import type { Context } from "hono";
import type { Env } from "../types";
import { transitionStage, logActivity, type Stage } from "./assr";

export interface SupplierReturnInput {
  pickup_at?: string | null;
  returned_at?: string | null;
  qc_result?: string | null;
  creditor_code?: string | null;
  reason?: string | null;
  note?: string | null;
}

/** The current (latest) trip = highest round_no among non-archived rows. Pure,
 *  so it can be unit-tested and reused by the reprojection. */
export function currentSupplierReturn<
  T extends { round_no: number; archived_at?: string | null },
>(rows: readonly T[]): T | null {
  const live = rows.filter((r) => !r.archived_at);
  if (!live.length) return null;
  return live.reduce((a, b) => (b.round_no > a.round_no ? b : a));
}

/** Next round number to mint = highest EXISTING number (archived included, so a
 *  number is never reused) + 1. Pure, so it is unit-tested directly. */
export function nextSupplierReturnRoundNo(
  rows: readonly { round_no: number }[],
): number {
  return rows.reduce((m, r) => Math.max(m, r.round_no), 0) + 1;
}

export async function listSupplierReturns(env: Env, assrId: number) {
  const r = await env.DB.prepare(
    `SELECT sr.*, u.name AS created_by_name, cr.company_name AS creditor_name
       FROM assr_supplier_returns sr
       LEFT JOIN users u ON u.id = sr.created_by
       LEFT JOIN creditors cr ON cr.creditor_code = sr.creditor_code
      WHERE sr.assr_id = ? AND sr.archived_at IS NULL
      ORDER BY sr.round_no ASC, sr.id ASC`
  )
    .bind(assrId)
    .all();
  return r.results ?? [];
}

// Re-point the case's summary columns at the current (latest) round so the
// Delivery board + HC Delivery sheet keep reading the trip in progress. Called
// after every add / patch / archive — the ONE place the mirror is kept.
async function reprojectLatestSupplierReturn(env: Env, assrId: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT round_no, pickup_at, returned_at
       FROM assr_supplier_returns WHERE assr_id = ? AND archived_at IS NULL`
  )
    .bind(assrId)
    .all();
  const cur = currentSupplierReturn((rows.results ?? []) as Array<{ round_no: number; pickup_at: string | null; returned_at: string | null }>);
  await env.DB.prepare(
    `UPDATE assr_cases
        SET supplier_pickup_at = ?, items_ready_at = ?, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(cur?.pickup_at ?? null, cur?.returned_at ?? null, assrId)
    .run();
}

// Add a factory trip (round N+1) and reopen the case onto the supplier pickup
// stage. Handles BOTH triggers the owner named: an in-flight rework loop (QC
// failed on receipt, case still open) and a re-return of a case that was already
// completed/delivered ("after completed stage 会有重新需要 Service"). The new row
// starts empty (ops fills the dates); `reason` says why it went back.
export async function openSupplierReturn(
  env: Env,
  assrId: number,
  userId: number,
  input: SupplierReturnInput,
): Promise<Record<string, unknown> | null> {
  const before = await env.DB.prepare(
    `SELECT stage, closed_at, creditor_code FROM assr_cases WHERE id = ?`
  )
    .bind(assrId)
    .first<{ stage: Stage; closed_at: string | null; creditor_code: string | null }>();
  if (!before) return null;

  const existing = await env.DB.prepare(
    `SELECT round_no FROM assr_supplier_returns WHERE assr_id = ?`
  )
    .bind(assrId)
    .all();
  const roundNo = nextSupplierReturnRoundNo((existing.results ?? []) as Array<{ round_no: number }>);

  await env.DB.prepare(
    `INSERT INTO assr_supplier_returns
       (assr_id, round_no, pickup_at, returned_at, qc_result,
        creditor_code, reason, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrId, roundNo,
      input.pickup_at ?? null, input.returned_at ?? null,
      input.qc_result ?? null, input.creditor_code ?? before.creditor_code, input.reason ?? null,
      input.note ?? null, userId,
    )
    .run();

  // The new (empty) round is now current — mirror it (clears the case columns
  // for the fresh trip). Reopen onto supplier pickup: transitionStage no-ops
  // when already there and stamps closed_at only on ENTERING a terminal stage,
  // never clears it, so a re-return on a completed/voided case clears the
  // terminal marker itself.
  await reprojectLatestSupplierReturn(env, assrId);
  await transitionStage(env, assrId, "pending_supplier_pickup", userId, `第 ${roundNo} 次返厂`, "app");
  if (before.closed_at) {
    await env.DB.prepare(
      `UPDATE assr_cases
          SET closed_at = NULL, completion_date = NULL, status = 'In Progress',
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(assrId)
      .run();
  }

  await logActivity(
    env, assrId, "supplier_return_opened", null, `round ${roundNo}`,
    input.reason ? `第 ${roundNo} 次返厂 — ${input.reason}` : `第 ${roundNo} 次返厂`,
    userId, { category: "supplier" },
  );
  return (await env.DB.prepare(
    `SELECT * FROM assr_supplier_returns WHERE assr_id = ? AND round_no = ? AND archived_at IS NULL`
  )
    .bind(assrId, roundNo)
    .first<Record<string, unknown>>()) ?? null;
}

// Edit one trip's recorded fields. Re-mirrors so the case columns follow the
// current trip when its dates change.
export async function patchSupplierReturn(
  env: Env,
  assrId: number,
  roundId: number,
  input: SupplierReturnInput,
): Promise<boolean> {
  const allowed = ["pickup_at", "returned_at", "qc_result", "creditor_code", "reason", "note"] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in input) {
      sets.push(`${k} = ?`);
      binds.push((input as Record<string, unknown>)[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(roundId, assrId);
  const r = await env.DB.prepare(
    `UPDATE assr_supplier_returns SET ${sets.join(", ")} WHERE id = ? AND assr_id = ? AND archived_at IS NULL`
  )
    .bind(...binds)
    .run();
  if (r.meta.changes > 0) await reprojectLatestSupplierReturn(env, assrId);
  return r.meta.changes > 0;
}

// Remove a mistakenly-recorded trip, then re-mirror onto the new current trip.
export async function archiveSupplierReturn(
  env: Env,
  assrId: number,
  roundId: number,
  userId: number,
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE assr_supplier_returns SET archived_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND assr_id = ? AND archived_at IS NULL`
  )
    .bind(roundId, assrId)
    .run();
  if (r.meta.changes > 0) {
    await reprojectLatestSupplierReturn(env, assrId);
    await logActivity(env, assrId, "supplier_return_archived", `round ${roundId}`, null, null, userId, { category: "supplier" });
  }
  return r.meta.changes > 0;
}

// ── Route handlers ────────────────────────────────────────────
// Registered thin in routes/assr.ts under /:id/supplier-returns (service_cases.write,
// inside the enforceCaseScope /:id guard). Kept here so the router stays small.
type Ctx = Context<{ Bindings: Env }>;
const uid = (c: Ctx): number => (c as unknown as { get?: (k: string) => number }).get?.("userId") ?? 0;

export async function openSupplierReturnRoute(c: Ctx) {
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<SupplierReturnInput>().catch(() => ({}) as SupplierReturnInput);
  const round = await openSupplierReturn(c.env, id, uid(c), body);
  return round ? c.json({ ok: true, round }) : c.json({ error: "Not found" }, 404);
}

export async function patchSupplierReturnRoute(c: Ctx) {
  const id = parseInt(c.req.param("id") ?? "", 10);
  const roundId = parseInt(c.req.param("roundId") ?? "", 10);
  if (isNaN(id) || isNaN(roundId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<SupplierReturnInput>().catch(() => ({}) as SupplierReturnInput);
  const ok = await patchSupplierReturn(c.env, id, roundId, body);
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
}

export async function archiveSupplierReturnRoute(c: Ctx) {
  const id = parseInt(c.req.param("id") ?? "", 10);
  const roundId = parseInt(c.req.param("roundId") ?? "", 10);
  if (isNaN(id) || isNaN(roundId)) return c.json({ error: "Invalid ID" }, 400);
  const ok = await archiveSupplierReturn(c.env, id, roundId, uid(c));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
}
