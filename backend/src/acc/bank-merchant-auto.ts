// ----------------------------------------------------------------------------
// acc/bank-merchant-auto — the bank's merchant money matches itself once the
// merchant side agrees.
//
// Owner, 2026-11-17, on 2990's Hong Leong credit of RM 615 for 14/11: its QR
// report line already linked to 2990-SO-2611-120 on Merchant Recon, and the
// bank screen still waited for a Match — 他应该和 merchant 一样我只要对一边，只是
// 如果银行实际收到的钱同个 merchant report 还有没有对上的才应该卡着.
//
// So a person does ONE side, Merchant Recon, and the bank follows by itself
// when its money agrees with the merchant report to the sen:
//   QR    a day's DuitNow QR credit that is READY (acc/bank-match qrSalesFor:
//         every QR line of its one report linked to its sale, every sale's live
//         entry on this bank, none held by another line, the sales making the
//         credit) is matched to those entries.
//   CARD  a payout the matcher tied to exactly one report for exactly what that
//         report is still owed, unsplit, is booked as Money received — what
//         "Money received — all matched payouts" books with one press. A report is offered to the bank only once every line
//         of it is confirmed (acc/bank loadPayableBatches), so this is a report
//         the merchant side has finished.
// Everything else stays for a person, as before: a different amount (a charge
// the bank kept is one), a split, two reports that could fit, a line still to
// link or confirm, a closed month. Pure: which lines, never how (scm/routes/accounting-bank.ts
// applyMerchantAgreedMatches does it through the same doors a press uses).
// ----------------------------------------------------------------------------

/** An OPEN bank credit with today's matcher decision and QR answer laid over it. */
export type AgreedLine = {
  id: number;
  amountSen: number;
  kind: string;
  matchedBatchId: number | null;
  split: unknown[] | null;
  qr: { ready: boolean; jeNos: string[] } | null;
};

/** A merchant report the bank may pay (every line of it confirmed), and what it is still owed. */
export type AgreedBatch = { id: number; outstandingSen: number };

export type AgreedAction =
  | { kind: 'qr'; lineId: number; jeNos: string[] }
  | { kind: 'payout'; lineId: number; batchId: number; amountSen: number };

/** The credits the merchant side already accounts for, in the order given. A
    report is paid by one credit here, and an entry claimed by one: a second
    credit that would take either is left for a person. */
export function merchantAgreedActions(lines: readonly AgreedLine[], batches: readonly AgreedBatch[]): AgreedAction[] {
  const batchOf = new Map(batches.map((b) => [b.id, b]));
  const paidBatches = new Set<number>();
  const usedEntries = new Set<string>();
  const out: AgreedAction[] = [];
  for (const l of lines) {
    if (!(l.amountSen > 0)) continue;
    if (l.kind === 'QR') {
      const jeNos = l.qr?.ready ? [...new Set(l.qr.jeNos)] : [];
      if (jeNos.length === 0 || jeNos.some((n) => usedEntries.has(n))) continue;
      for (const n of jeNos) usedEntries.add(n);
      out.push({ kind: 'qr', lineId: l.id, jeNos });
      continue;
    }
    if (l.kind !== 'PAYOUT' || l.matchedBatchId == null) continue;
    if ((l.split?.length ?? 0) > 0) continue;
    const b = batchOf.get(l.matchedBatchId);
    if (!b || b.outstandingSen !== l.amountSen) continue;
    if (paidBatches.has(b.id)) continue;
    paidBatches.add(b.id);
    out.push({ kind: 'payout', lineId: l.id, batchId: b.id, amountSen: l.amountSen });
  }
  return out;
}
