// ----------------------------------------------------------------------------
// pi-settlement — move a purchase invoice's paid_centi, with the upper bound
// clamped so two payment vouchers cannot settle the same invoice past its total.
//
// THE DEFECT (see src/db/migrations-pg/0147_scm_settle_pi_paid_centi.sql for
// the long version). Posting a SUPPLIER_PAYMENT voucher read the PI, computed
// `outstanding = total - paid`, capped its allocation at that, and then wrote.
// Two vouchers settling the SAME invoice concurrently each read the same
// `outstanding` and each applied their full share against it — a cap that was
// true when read and false when written. The invoice ends up paid twice over.
//
// It is not a lost update: the optimistic gate on paid_centi ensured BOTH
// increments landed. The stale value was the CAP, not the addend, so no amount
// of retrying fixes it. Only the database evaluating the cap at write time does
// — which is what settle_pi_paid_centi does, and what HOOKKA's
// BUG-2026-05-21-001 fix did in the other direction.
// ----------------------------------------------------------------------------

import { isMissingRpc } from './rpc-missing';

export type PiSettleReason = 'no_delta' | 'not_found' | 'not_live' | 'update_failed' | 'contention';

export type PiSettleComputation = {
  /** The PI is not a live liability (DRAFT/CANCELLED) — nothing moves. */
  skipped: boolean;
  newPaidCenti: number;
  /** What actually moved. Signed, and never larger in magnitude than the delta. */
  appliedCenti: number;
  /** requested − applied. Non-zero means the clamp bit and money was refused. */
  clampedCenti: number;
  newStatus: string;
};

/**
 * The ONE rule for what a settlement does to a purchase invoice. Pure, so the
 * atomic SQL path and the legacy fallback below cannot drift into two different
 * opinions about what a settle means — the SQL function is a transcription of
 * exactly this.
 *
 * Positive delta (a voucher posting) is clamped UP AT total_centi. The outer
 * max() keeps a PI that is already over total (legacy data from before the
 * clamp existed) from being silently dragged DOWN by an unrelated settle: this
 * only ever moves paid_centi in the direction of the delta it was handed.
 *
 * Negative delta (a voucher cancel reversing its own settlement) keeps the
 * historic floor at 0 and takes NO upper clamp — an already-over-paid invoice
 * must be able to unwind completely, or the excess is stranded forever.
 */
export function computePiSettlement(input: {
  paidCenti: number;
  totalCenti: number;
  status: string | null | undefined;
  deltaCenti: number;
}): PiSettleComputation {
  const paid = Number(input.paidCenti ?? 0);
  const total = Number(input.totalCenti ?? 0);
  const delta = Number(input.deltaCenti ?? 0);
  const status = (input.status ?? '').toUpperCase();

  if (status === 'DRAFT' || status === 'CANCELLED') {
    return { skipped: true, newPaidCenti: paid, appliedCenti: 0, clampedCenti: 0, newStatus: input.status ?? '' };
  }

  const newPaid = delta > 0
    ? Math.max(paid, Math.min(total, paid + delta))
    : Math.max(0, paid + delta);

  const applied = newPaid - paid;
  const newStatus = newPaid >= total ? 'PAID' : (newPaid > 0 ? 'PARTIALLY_PAID' : 'POSTED');

  return { skipped: false, newPaidCenti: newPaid, appliedCenti: applied, clampedCenti: delta - applied, newStatus };
}

export type PiSettleResult = {
  ok: boolean;
  /** What was actually applied. The caller MUST record this, not what it asked
   *  for — a later cancel reverses exactly this figure. */
  appliedCenti: number;
  /** Non-zero when the database refused part of the request. Surfaced by the
   *  caller, never swallowed: it means somebody tried to over-pay an invoice. */
  clampedCenti: number;
  reason?: PiSettleReason | string;
  /** True when the legacy (non-atomic) path ran because the RPC is not applied
   *  to this database yet. */
  legacy?: boolean;
};

/**
 * Move a PI's paid_centi by `delta` and re-derive its status (migration 0202).
 *
 * ATOMIC PATH — scm.settle_pi_paid_centi takes a row lock, evaluates the clamp
 * against the row as it is AT WRITE TIME, and returns what it actually applied.
 * Two concurrent settles serialise on that lock instead of racing.
 *
 * FALLBACK — until the function is applied to a given database the RPC is
 * absent; we detect that (and only that) and run the legacy optimistic loop.
 * That loop now evaluates the SAME clamp via computePiSettlement, so it is a
 * strict improvement on what was there, but it is still read-then-write and can
 * still be raced. Behaviour with no concurrency is identical either way.
 *
 * Best-effort by contract: a settle hiccup must never un-post an already-posted
 * voucher. Failures are reported, never silent.
 */
export async function settlePiPaidCenti(sb: any, piId: string, delta: number): Promise<PiSettleResult> {
  if (!piId || !Number.isFinite(delta) || delta === 0) {
    return { ok: true, appliedCenti: 0, clampedCenti: 0, reason: 'no_delta' };
  }

  const { data, error } = await sb.rpc('settle_pi_paid_centi', {
    p_pi_id: piId,
    p_delta: Math.round(delta),
  });

  if (!error) {
    // RETURNS TABLE(...) → PostgREST hands back an array of one row.
    const row = (Array.isArray(data) ? data[0] : data) as
      { applied_centi?: number; new_paid_centi?: number; new_status?: string; reason?: string } | undefined;
    const applied = Number(row?.applied_centi ?? 0);
    return {
      ok: true,
      appliedCenti: applied,
      clampedCenti: Math.round(delta) - applied,
      reason: row?.reason ?? undefined,
    };
  }

  if (!isMissingRpc(error)) {
    /* A real DB error — the function ran and rolled back, or never started.
       Do NOT fall through to the non-atomic path against a database that just
       rejected the atomic one. The caller records applied 0, so the ledger
       says what actually happened: nothing. */
    /* eslint-disable-next-line no-console */
    console.error('[pv-settle-pi] atomic settle RPC failed — PI left unsettled:', piId, 'delta', delta, error.message);
    return { ok: false, appliedCenti: 0, clampedCenti: 0, reason: error.message };
  }

  return settlePiPaidCentiLegacy(sb, piId, delta);
}

/**
 * LEGACY optimistic-concurrency path, used only when scm.settle_pi_paid_centi
 * has not been applied yet. Gate the UPDATE on the paid_centi just read and
 * retry on a 0-row (concurrent) result.
 */
async function settlePiPaidCentiLegacy(sb: any, piId: string, delta: number): Promise<PiSettleResult> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur, error: readErr } = await sb.from('purchase_invoices')
      .select('paid_centi, total_centi, status').eq('id', piId).maybeSingle();
    /* A failed READ is not "the invoice isn't there". Returning ok on a blip
       would have the caller record applied 0 and move on quietly, when in fact
       we never found out. */
    if (readErr) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-settle-pi] PI read failed — left unsettled:', piId, 'delta', delta, readErr.message);
      return { ok: false, appliedCenti: 0, clampedCenti: 0, reason: readErr.message, legacy: true };
    }
    if (!cur) return { ok: true, appliedCenti: 0, clampedCenti: 0, reason: 'not_found', legacy: true };

    const c0 = cur as { paid_centi: number; total_centi: number; status: string };
    const calc = computePiSettlement({
      paidCenti: Number(c0.paid_centi ?? 0),
      totalCenti: Number(c0.total_centi ?? 0),
      status: c0.status,
      deltaCenti: Math.round(delta),
    });
    if (calc.skipped) return { ok: true, appliedCenti: 0, clampedCenti: 0, reason: 'not_live', legacy: true };
    if (calc.appliedCenti === 0) {
      return { ok: true, appliedCenti: 0, clampedCenti: calc.clampedCenti, legacy: true };
    }

    const { data, error } = await sb.from('purchase_invoices').update({
      paid_centi: calc.newPaidCenti, status: calc.newStatus, updated_at: new Date().toISOString(),
    })
      .eq('id', piId)
      .eq('paid_centi', c0.paid_centi) // only if nobody else moved it since the read
      .select('id');

    /* Still best-effort — a settle hiccup must never un-post an already-posted
       PV. What matters is that it is not SILENT. The caller writes
       pv_allocations.applied_centi immediately after this returns, so a failure
       here leaves the ledger asserting money was applied to a PI whose
       paid_centi never moved, and a later cancel reverses an amount that was
       never there. Nothing downstream can detect that, so this line is the only
       way anyone learns of it. */
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-settle-pi] paid_centi update failed — PI left unsettled:', piId, 'delta', delta, error.message);
      return { ok: false, appliedCenti: 0, clampedCenti: 0, reason: error.message, legacy: true };
    }
    if (data && data.length > 0) {
      return { ok: true, appliedCenti: calc.appliedCenti, clampedCenti: calc.clampedCenti, legacy: true };
    }
    // 0 rows back = somebody else moved paid_centi since the read; re-read and retry.
  }

  /* Six losses in a row against the same invoice. Reporting applied 0 is the
     honest answer — we do not know that anything landed, and the caller must
     not record a settlement it cannot prove. */
  /* eslint-disable-next-line no-console */
  console.error('[pv-settle-pi] gave up after 6 concurrent-update retries — PI left unsettled:', piId, 'delta', delta);
  return { ok: false, appliedCenti: 0, clampedCenti: 0, reason: 'contention', legacy: true };
}
