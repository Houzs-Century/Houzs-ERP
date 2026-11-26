// ----------------------------------------------------------------------------
// waiting-card-payments — the card money the ERP took that no merchant report
// has carried yet (未到账收款, watch list 1). ONE list, read by Merchant Recon's
// "Card payments no merchant report has reported yet" and by Bank Recon, where
// a bank movement may take such a payment in itself (owner 2026-11-17: 2990's
// swipes on Houzs's AEON terminal come back as Houzs's transfer).
//
// Each active merchant's pool is read (a payment tagged with a merchant is in
// that merchant's pool only; an untagged one in every pool, so each report can
// find it), the payments already taken are dropped (acc/settled-keys: a report
// line's or a bank movement's), and an untagged payment is listed ONCE, under no
// merchant (docs/bugs/0688).
// ----------------------------------------------------------------------------

import { loadPaymentCandidates } from './settlement';
import { loadSettledKeysFor } from './settled-keys';
import { listOnce, recordedNotArrived, type PaymentCandidate } from './settlement-match';
import type { resolveRoles } from './rules';

type Sb = Parameters<typeof resolveRoles>[0];

export type WaitingMerchant = { code: string; display_name: string; date_tolerance_days: number; so_names?: string[] | null };
export type WaitingCardPayment = PaymentCandidate & { ageDays: number; acquirerCode: string | null };

/** The merchants' pools walked in the order given — listOnce depends on it — each
    payment not yet taken listed once, oldest-waiting first within its merchant. */
export async function loadWaitingCardPayments(
  sb: Sb, companyId: number, merchants: readonly WaitingMerchant[], from: string, to: string,
): Promise<{ ok: true; payments: WaitingCardPayment[] } | { ok: false; reason: string }> {
  const pools = await Promise.all(merchants.map((a) => loadPaymentCandidates(sb, companyId, a, from, to)));
  const pooled: PaymentCandidate[] = [];
  for (const got of pools) {
    if (!got.ok) return { ok: false, reason: got.reason };
    pooled.push(...got.payments);
  }
  const settled = await loadSettledKeysFor(sb, companyId, pooled);
  if (!settled.ok) return { ok: false, reason: settled.reason };
  const payments: WaitingCardPayment[] = [];
  const listedUntagged = new Set<string>();
  merchants.forEach((a, i) => {
    const got = pools[i] as { ok: true; payments: PaymentCandidate[] };
    payments.push(...listOnce(recordedNotArrived(got.payments, settled.keys, to), a.code, listedUntagged));
  });
  return { ok: true, payments };
}
