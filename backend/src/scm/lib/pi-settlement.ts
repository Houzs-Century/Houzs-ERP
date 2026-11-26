
import { isMissingRpc } from './rpc-missing';

export type PiSettleReason = 'no_delta' | 'not_found' | 'not_live' | 'update_failed' | 'contention';

export type PiSettleComputation = {
  skipped: boolean;
  newPaidSen: number;
  appliedSen: number;
  clampedSen: number;
  newStatus: string;
};

/**
 * The ONE rule for what a settlement does to a purchase invoice. Pure, so the
 * atomic SQL path and the legacy fallback below cannot drift into two different
 * opinions about what a settle means — the SQL function is a transcription of
 * exactly this.
 *
 * Positive delta (a voucher posting) is clamped UP AT total_sen. The outer
 * max() keeps a PI that is already over total (legacy data from before the
 * clamp existed) from being silently dragged DOWN by an unrelated settle: this
 * only ever moves paid_sen in the direction of the delta it was handed.
 *
 * Negative delta (a voucher cancel reversing its own settlement) keeps the
 * historic floor at 0 and takes NO upper clamp — an already-over-paid invoice
 * must be able to unwind completely, or the excess is stranded forever.
 */
export function computePiSettlement(input: {
  paidSen: number;
  totalSen: number;
  status: string | null | undefined;
  deltaSen: number;
}): PiSettleComputation {
  const paid = Number(input.paidSen ?? 0);
  const total = Number(input.totalSen ?? 0);
  const delta = Number(input.deltaSen ?? 0);
  const status = (input.status ?? '').toUpperCase();

  if (status === 'DRAFT' || status === 'CANCELLED') {
    return { skipped: true, newPaidSen: paid, appliedSen: 0, clampedSen: 0, newStatus: input.status ?? '' };
  }

  const newPaid = delta > 0
    ? Math.max(paid, Math.min(total, paid + delta))
    : Math.max(0, paid + delta);

  const applied = newPaid - paid;
  const newStatus = newPaid >= total ? 'PAID' : (newPaid > 0 ? 'PARTIALLY_PAID' : 'POSTED');

  return { skipped: false, newPaidSen: newPaid, appliedSen: applied, clampedSen: delta - applied, newStatus };
}

export type PiSettleResult = {
  ok: boolean;
  appliedSen: number;
  clampedSen: number;
  reason?: PiSettleReason | string;
  legacy?: boolean;
};

/**
 * Move a PI's paid_sen by `delta` and re-derive its status (migration 0202).
 *
 * ATOMIC PATH — scm.settle_pi_paid_sen takes a row lock, evaluates the clamp
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
export async function settlePiPaidSen(sb: any, piId: string, delta: number): Promise<PiSettleResult> {
  if (!piId || !Number.isFinite(delta) || delta === 0) {
    return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'no_delta' };
  }

  const { data, error } = await sb.rpc('settle_pi_paid_sen', {
    p_pi_id: piId,
    p_delta: Math.round(delta),
  });

  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as
      { applied_sen?: number; new_paid_sen?: number; new_status?: string; reason?: string } | undefined;
    const applied = Number(row?.applied_sen ?? 0);
    return {
      ok: true,
      appliedSen: applied,
      clampedSen: Math.round(delta) - applied,
      reason: row?.reason ?? undefined,
    };
  }

  if (!isMissingRpc(error)) {
    /* eslint-disable-next-line no-console */
    console.error('[pv-settle-pi] atomic settle RPC failed — PI left unsettled:', piId, 'delta', delta, error.message);
    return { ok: false, appliedSen: 0, clampedSen: 0, reason: error.message };
  }

  return settlePiPaidSenLegacy(sb, piId, delta);
}

async function settlePiPaidSenLegacy(sb: any, piId: string, delta: number): Promise<PiSettleResult> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur, error: readErr } = await sb.from('purchase_invoices')
      .select('paid_sen, total_sen, status').eq('id', piId).maybeSingle();
    if (readErr) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-settle-pi] PI read failed — left unsettled:', piId, 'delta', delta, readErr.message);
      return { ok: false, appliedSen: 0, clampedSen: 0, reason: readErr.message, legacy: true };
    }
    if (!cur) return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'not_found', legacy: true };

    const c0 = cur as { paid_sen: number; total_sen: number; status: string };
    const calc = computePiSettlement({
      paidSen: Number(c0.paid_sen ?? 0),
      totalSen: Number(c0.total_sen ?? 0),
      status: c0.status,
      deltaSen: Math.round(delta),
    });
    if (calc.skipped) return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'not_live', legacy: true };
    if (calc.appliedSen === 0) {
      return { ok: true, appliedSen: 0, clampedSen: calc.clampedSen, legacy: true };
    }

    const { data, error } = await sb.from('purchase_invoices').update({
      paid_sen: calc.newPaidSen, status: calc.newStatus, updated_at: new Date().toISOString(),
    })
      .eq('id', piId)
      .eq('paid_sen', c0.paid_sen)
      .select('id');

    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-settle-pi] paid_sen update failed — PI left unsettled:', piId, 'delta', delta, error.message);
      return { ok: false, appliedSen: 0, clampedSen: 0, reason: error.message, legacy: true };
    }
    if (data && data.length > 0) {
      return { ok: true, appliedSen: calc.appliedSen, clampedSen: calc.clampedSen, legacy: true };
    }
  }

  /* eslint-disable-next-line no-console */
  console.error('[pv-settle-pi] gave up after 6 concurrent-update retries — PI left unsettled:', piId, 'delta', delta);
  return { ok: false, appliedSen: 0, clampedSen: 0, reason: 'contention', legacy: true };
}
