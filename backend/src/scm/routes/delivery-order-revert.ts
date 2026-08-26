// POST /delivery-orders-mfg/:id/revert — the Ops-lead EXCEPTION power (2026-08-26,
// owner: 「Executive 及以上可把单据状态撤回/强制重置（扫错码、误触 Dispatch）」).
//
// The warehouse confirms a load by scanning (→ LOADED, which is the stock-OUT
// since 2026-08-22), and the fleet sends it (→ DISPATCHED). Both are mistakes a
// human makes on a busy dock: the wrong delivery order scanned, or Dispatch hit
// by accident. This endpoint is the safety net — an Ops Executive (or above,
// whoever the editable matrix grants `scm.do.revert`) pulls the order back and,
// when that crosses the stock-out boundary, the inventory returns.
//
// WHY A DEDICATED ROUTE, not the status PATCH. `PATCH /:id/status` REFUSES a
// shipped→pre-ship move (LOADED→DRAFT) precisely because a plain status write
// does not reverse the inventory OUT, so it would leave the DO reading un-shipped
// with its stock still deducted (delivery-orders-mfg.ts / do-shipped-states.ts).
// The revert is the ONE path allowed to cross that line, and it earns it by
// reversing the stock in the same call — the same cleanup the CANCELLED branch
// runs (reverseInventoryForDo + rack return + SO delivered-sync + allocation
// re-walk), minus the AutoCount cancel, because a revert is not a cancel: the
// document stays alive and re-workable.
//
// WHAT IS REVERTABLE, and why so narrow. Only LOADED (wrong scan) and DISPATCHED
// (accidental send) — the two the owner named. A delivery already IN_TRANSIT /
// SIGNED / DELIVERED / INVOICED is on the road or done, and DRAFT / CANCELLED
// have nothing to undo. Backward only. And a DO with a live Sales Invoice or
// Delivery Return is refused (`doHasDownstream`): un-shipping under a document
// that references the shipment would desync it — void that first.
//
// STOCK MOVES ONLY WHEN CROSSING TO DRAFT. LOADED and DISPATCHED are both
// stock-out; DRAFT is the only pre-ship target. So DISPATCHED→LOADED (un-send)
// moves no stock, while anything→DRAFT (un-load / full reset) restores it.
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { reverseInventoryForDo, returnDoRacksOnCancel } from './delivery-orders-mfg';
import { syncSoDeliveredFromDo } from '../lib/so-delivery-sync';
import { doHasDownstream } from '../lib/downstream-lock';
import { recordEntityAudit, compactChanges, fieldChange } from '../lib/entity-audit';
import { hasPositionCapability } from '../../services/positionCapabilities';
import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';

// The only two states a revert may START from, and the lifecycle rank used to
// prove the target is strictly earlier. DRAFT=0 is the pre-ship floor.
const REVERTABLE_FROM = new Set(['LOADED', 'DISPATCHED']);
const RANK: Record<string, number> = { DRAFT: 0, LOADED: 1, DISPATCHED: 2 };

export const revertDeliveryOrderHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);
  const caller = c.get('houzsUser'); // the REAL caller (the bridge pins user=staff)
  // Inventory rows are stamped with the pinned staff uuid, exactly as the
  // deduct / cancel-reverse paths do (delivery-orders-mfg.ts uses `user.id`).
  const performedBy = (c.get('user') as { id?: string } | undefined)?.id ?? String(caller?.id ?? 'system');

  // 1) CAPABILITY — the exception power itself. ALWAYS required, even for a
  //    caller admitted on real scm.sales.delivery edit: a dispatcher may move a
  //    status forward, but UN-moving it (and returning stock) is the Ops lead's.
  //    `*` passes inside hasPositionCapability, so an owner/super-admin is exempt.
  if (!hasPositionCapability(caller, 'scm.do.revert')) {
    return c.json(
      {
        error: 'capability_required',
        reason:
          'Reverting a delivery order is an exception action for your Operations lead. Ask them to revert it.',
      },
      403,
    );
  }

  // 2) BODY — an explicit backward target and a reason (the audit needs it).
  let body: { toStatus?: string; reason?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const toStatus = String(body.toStatus ?? '').trim().toUpperCase();
  const reason = String(body.reason ?? '').trim();
  if (toStatus !== 'LOADED' && toStatus !== 'DRAFT') {
    return c.json(
      { error: 'invalid_target', reason: 'A revert may only move a delivery order back to LOADED or DRAFT.' },
      400,
    );
  }
  if (!reason) {
    return c.json({ error: 'reason_required', reason: 'A reason is required to revert a delivery order.' }, 400);
  }

  // 3) SCOPED LOAD — a DO is a per-company document; never revert another
  //    company's order (mirrors the status handler's scoped read).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: doRow, error: doErr } = await scopeToCompanyId(
    sb.from('delivery_orders').select('id, do_number, status, company_id, so_doc_no').eq('id', id),
    co.companyId,
  ).maybeSingle();
  // Surface a read failure as 500 — masking it as 404 (NOT_THIS_COMPANY) would
  // tell the operator the DO does not exist when the database simply hiccuped.
  if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
  if (!doRow) return c.json(NOT_THIS_COMPANY, 404);
  const row = doRow as { do_number?: string | null; status?: string | null; company_id?: number | null; so_doc_no?: string | null };
  const from = String(row.status ?? '').toUpperCase();
  const doNo = row.do_number ?? id;
  const companyId = row.company_id ?? co.companyId;

  // 4) LEGAL-TRANSITION GUARD — only the two named mistakes, backward only.
  if (!REVERTABLE_FROM.has(from)) {
    return c.json(
      { error: 'not_revertable', reason: `A ${from} delivery order cannot be reverted — only a LOADED or DISPATCHED one can.` },
      409,
    );
  }
  if ((RANK[toStatus] ?? 0) >= (RANK[from] ?? 0)) {
    return c.json({ error: 'not_backward', reason: `A revert only moves backward; ${from} cannot revert to ${toStatus}.` }, 409);
  }

  // 5) DOWNSTREAM LOCK — a live Sales Invoice / Delivery Return references this
  //    shipment; un-shipping under it desyncs the invoice/return. Handle those
  //    first. (Also catches INVOICED, which necessarily has an SI.)
  const childLock = await doHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  // 6) FLIP FIRST, guarded on the status we read, so a concurrent move can't be
  //    clobbered — then run the side effects (same order as the CANCELLED
  //    branch). dispatched_at is cleared on any revert out of DISPATCHED so a
  //    re-dispatch stamps a fresh time.
  const now = new Date().toISOString();
  const patch: Record<string, string | null> = { status: toStatus, updated_at: now };
  if (from === 'DISPATCHED') patch.dispatched_at = null;
  const { data: updated, error: updErr } = await scopeToCompanyId(
    sb.from('delivery_orders').update(patch).eq('id', id),
    co.companyId,
  )
    .eq('status', from)
    .select('id, status')
    .maybeSingle();
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  if (!updated) {
    // Lost the race — the DO moved status under us. Do NOT reverse anything.
    return c.json(
      { error: 'status_changed', reason: 'The delivery order changed status before the revert applied. Reload and try again.' },
      409,
    );
  }

  // 7) STOCK — reverse ONLY when crossing the stock-out boundary back to DRAFT.
  //    Both revertable FROM states are stock-out, DRAFT is the only pre-ship TO,
  //    so this is exactly `toStatus === 'DRAFT'`. reverseInventoryForDo is
  //    idempotent (existence check + uq_inv_mov_do_source_v2) and reported.
  const warnings: string[] = [];
  const reversesStock = toStatus === 'DRAFT';
  if (reversesStock) {
    try {
      warnings.push(...(await reverseInventoryForDo(sb, id, performedBy)));
    } catch (e) {
      warnings.push(`DO reversal threw: ${e instanceof Error ? e.message : 'unknown'}`);
    }
    // Physical rack stock back (best-effort — never blocks the revert).
    try {
      await returnDoRacksOnCancel(sb, id, doNo, performedBy, companyId);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[do-revert] rack return failed:', e);
    }
    // The SO this DO drew on is no longer delivered by it — recompute live.
    try {
      await syncSoDeliveredFromDo(sb, [row.so_doc_no], performedBy);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[do-revert] so-sync failed:', e);
    }
    // Freed stock — re-walk SO lines so PENDING orders flip back to READY.
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[do-revert] so-allocation failed:', e);
    }
  }

  // 8) AUDIT — REVERSE, carrying the reason and the status change. Best-effort,
  //    after the write, like every other audit in this module.
  await recordEntityAudit(sb, {
    entityType: 'DELIVERY_ORDER',
    entityId: id,
    entityDocNo: doNo,
    action: 'REVERSE',
    actor: caller,
    companyId,
    statusSnapshot: toStatus,
    note: `Reverted ${from} → ${toStatus}${reversesStock ? ' (stock restored)' : ''}: ${reason}`,
    fieldChanges: compactChanges([fieldChange('status', from, toStatus)]),
  });

  return c.json({
    deliveryOrder: updated,
    from,
    to: toStatus,
    inventoryReversed: reversesStock,
    warnings: warnings.length ? warnings : undefined,
  });
};

export default revertDeliveryOrderHandler;
