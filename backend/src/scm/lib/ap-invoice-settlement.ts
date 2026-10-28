// ----------------------------------------------------------------------------
// ap-invoice-settlement — move an AP INVOICE's paid_sen the way pi-settlement
// moves a purchase invoice's: atomic through scm.settle_api_paid_sen (row lock,
// clamp evaluated at write time, returns what it applied), legacy optimistic
// loop only while that function is not yet applied to a database. The rule
// itself is computePiSettlement — one opinion of what a settle means, shared
// with the PI path on purpose: an AP Payment ticks PIs and AP invoices side by
// side (owner 2026-09-06), and they must knock off identically.
// ----------------------------------------------------------------------------

import { isMissingRpc } from './rpc-missing';
import { computePiSettlement, type PiSettleResult } from './pi-settlement';

export async function settleApInvoicePaidSen(sb: any, invoiceId: string, delta: number): Promise<PiSettleResult> {
  if (!invoiceId || !Number.isFinite(delta) || delta === 0) {
    return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'no_delta' };
  }

  const { data, error } = await sb.rpc('settle_api_paid_sen', {
    p_id: invoiceId,
    p_delta: Math.round(delta),
  });

  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as
      { applied_sen?: number; new_paid_sen?: number; new_status?: string; reason?: string } | undefined;
    const applied = Number(row?.applied_sen ?? 0);
    return { ok: true, appliedSen: applied, clampedSen: Math.round(delta) - applied, reason: row?.reason ?? undefined };
  }

  if (!isMissingRpc(error)) {
    /* eslint-disable-next-line no-console */
    console.error('[pv-settle-api] atomic settle RPC failed — AP invoice left unsettled:', invoiceId, 'delta', delta, error.message);
    return { ok: false, appliedSen: 0, clampedSen: 0, reason: error.message };
  }

  return settleLegacy(sb, invoiceId, delta);
}

/** Optimistic-concurrency fallback, used only until scm.settle_api_paid_sen
    exists on the database at hand. Same clamp, read-then-write. */
async function settleLegacy(sb: any, invoiceId: string, delta: number): Promise<PiSettleResult> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur, error: readErr } = await sb.from('ap_invoices')
      .select('paid_sen, total_sen, status').eq('id', invoiceId).maybeSingle();
    if (readErr) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-settle-api] AP invoice read failed — left unsettled:', invoiceId, 'delta', delta, readErr.message);
      return { ok: false, appliedSen: 0, clampedSen: 0, reason: readErr.message, legacy: true };
    }
    if (!cur) return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'not_found', legacy: true };

    const c0 = cur as { paid_sen: number | null; total_sen: number | null; status: string };
    const calc = computePiSettlement({
      paidSen: Number(c0.paid_sen ?? 0),
      totalSen: Number(c0.total_sen ?? 0),
      status: c0.status,
      deltaSen: Math.round(delta),
    });
    if (calc.skipped) return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'not_live', legacy: true };
    if (calc.appliedSen === 0) return { ok: true, appliedSen: 0, clampedSen: calc.clampedSen, legacy: true };

    const { data: upd, error: updErr } = await sb.from('ap_invoices')
      .update({ paid_sen: calc.newPaidSen, status: calc.newStatus })
      .eq('id', invoiceId)
      .eq('paid_sen', c0.paid_sen)
      .select('id');
    if (updErr) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-settle-api] AP invoice update failed — left unsettled:', invoiceId, updErr.message);
      return { ok: false, appliedSen: 0, clampedSen: 0, reason: updErr.message, legacy: true };
    }
    if (((upd ?? []) as unknown[]).length > 0) {
      return { ok: true, appliedSen: calc.appliedSen, clampedSen: calc.clampedSen, legacy: true };
    }
    /* 0 rows: somebody moved paid_sen underneath us — re-read and retry. */
  }
  return { ok: false, appliedSen: 0, clampedSen: 0, reason: 'contention', legacy: true };
}
