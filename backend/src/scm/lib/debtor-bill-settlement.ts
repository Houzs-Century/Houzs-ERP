// ----------------------------------------------------------------------------
// debtor-bill-settlement — move an Other Debtor BILL's received_sen the way
// ap-invoice-settlement moves an AP invoice's paid_sen: atomic through
// scm.settle_odb_received_sen (row lock, clamp at write time, returns what it
// applied). An other-debtor credit note's credit comes off the debtor's bills
// through it (acc/credit-note-allocations.ts), so a cancel gives back exactly
// what was applied. The function ships with the migration that lets a note be
// TO an other debtor, so there is no pre-function fallback to keep.
// ----------------------------------------------------------------------------

import type { PiSettleResult } from './pi-settlement';

export async function settleDebtorBillReceivedSen(sb: any, billId: string, delta: number): Promise<PiSettleResult> {
  if (!billId || !Number.isFinite(delta) || delta === 0) {
    return { ok: true, appliedSen: 0, clampedSen: 0, reason: 'no_delta' };
  }
  const { data, error } = await sb.rpc('settle_odb_received_sen', { p_id: billId, p_delta: Math.round(delta) });
  if (error) {
    /* eslint-disable-next-line no-console */
    console.error('[odb-settle] atomic settle RPC failed — debtor bill left as it was:', billId, 'delta', delta, error.message);
    return { ok: false, appliedSen: 0, clampedSen: 0, reason: error.message };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { applied_sen?: number; reason?: string } | undefined;
  const applied = Number(row?.applied_sen ?? 0);
  return { ok: true, appliedSen: applied, clampedSen: Math.round(delta) - applied, reason: row?.reason ?? undefined };
}
