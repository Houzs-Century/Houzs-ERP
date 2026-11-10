// ----------------------------------------------------------------------------
// card-in-bank — how much of a card payment the acquirer has paid into a bank
// by a given day (owner 2026-11-05: card money is Cash In on the swipe date),
// and whether the merchant's report has matched the rest (owner 2026-11-06:
// 分多一个 condition).
//
// The chain is the settlement module's own: the payment row (the SOPAY / SIPAY
// journal's source_doc_no) → acc_settlement_matches → its settlement line →
// that line's statement (batch) → the statement's bank credits
// (acc_settlement_receipts). A statement pays out as one or more credits, so a
// payment is in the bank in the proportion its statement has been received
// (credits plus what the bank kept off them, against what the statement said
// it would pay), capped at all of it. A payment no statement claims is not in
// the bank.
//
// What the bank kept is booked in one of two places: on the credit itself
// (acc_settlement_receipts.charge_sen), or on the payout's ADVICE DAY
// (acc_settlement_payout_batches.charge_sen, acc/payout-charge — PBB's 06/06
// "Offset Amount" of RM 324 he booked on 2026-09-10). Both count, the advice
// day's once its report has a credit in the bank: kept off that payout, it
// settles with it (owner 2026-11-10: 应该是324，那时说了是手续费不是？ — the
// report had read "the bank has paid 90%").
//
// Merchant matched is its own answer, never "in the bank": the acquirer has said
// it will pay, and it does, usually within 3 days, but at a month end that money
// can be a third of the month's swipes (2990 on 31/08), and the report's bank
// columns agree with the bank statements.
// ----------------------------------------------------------------------------

import { paginateAll } from '../scm/lib/paginate-all';
import type { resolveRoles } from './rules';

export type CardPayoutFacts = {
  matches: Array<{ payment_source: string; payment_id: string; settlement_row_id: number }>;
  rows: Array<{ id: number; batch_id: number; confirmed_at: string | null }>;
  batches: Array<{ id: number; stated_net_sen: number | null; net_sen: number | null }>;
  receipts: Array<{ batch_id: number; received_on: string; amount_sen: number; charge_sen: number | null; je_no: string | null }>;
  /** What the bank kept off a payout, booked on its advice day; a caller that reads no advice days passes none. */
  dayCharges?: Array<{ batch_id: number; charge_sen: number | null; charge_je_no: string | null }>;
};

export const paymentKey = (source: string, paymentId: string): string => `${source.replace(/_REVERSAL$/, '')}:${paymentId}`;

/** Each claimed payment's share (0..1) that reached a bank on or before `asOf`, keyed by paymentKey. */
export function inBankShares(facts: CardPayoutFacts, asOf: string): Map<string, number> {
  const payable = new Map<number, number>();
  for (const b of facts.batches) payable.set(Number(b.id), Number(b.stated_net_sen ?? b.net_sen ?? 0));
  const received = new Map<number, number>();
  for (const r of facts.receipts) {
    if (!r.je_no || String(r.received_on).slice(0, 10) > asOf) continue;
    const id = Number(r.batch_id);
    received.set(id, (received.get(id) ?? 0) + Number(r.amount_sen) + Number(r.charge_sen ?? 0));
  }
  /* A charge booked on the advice day settles with the payout it was kept off: counted
     once its report has a credit in the bank by `asOf`, and only when it is posted. */
  for (const d of facts.dayCharges ?? []) {
    const id = Number(d.batch_id);
    const kept = Number(d.charge_sen ?? 0);
    if (!d.charge_je_no || kept <= 0 || !received.has(id)) continue;
    received.set(id, (received.get(id) ?? 0) + kept);
  }
  const shareOfBatch = (id: number): number => {
    const due = payable.get(id) ?? 0;
    const got = received.get(id) ?? 0;
    if (got <= 0) return 0;
    if (due <= 0) return 1;
    return Math.min(1, got / due);
  };
  const batchOfRow = new Map<number, number>();
  for (const r of facts.rows) batchOfRow.set(Number(r.id), Number(r.batch_id));
  const out = new Map<string, number>();
  for (const m of facts.matches) {
    const batch = batchOfRow.get(Number(m.settlement_row_id));
    if (batch === undefined) continue;
    out.set(paymentKey(m.payment_source, String(m.payment_id)), shareOfBatch(batch));
  }
  return out;
}

/** The payments a merchant's report has matched, keyed by paymentKey. A confirmed line
    only: a link on a line still waiting is the machine's proposal, not an answer. */
export function merchantMatched(facts: CardPayoutFacts): Set<string> {
  const confirmed = new Set<number>();
  for (const r of facts.rows) if (r.confirmed_at) confirmed.add(Number(r.id));
  const out = new Set<string>();
  for (const m of facts.matches) {
    if (confirmed.has(Number(m.settlement_row_id))) out.add(paymentKey(m.payment_source, String(m.payment_id)));
  }
  return out;
}

/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];

/** The company's whole settlement history — five small tables, read once. */
export async function loadCardPayoutFacts(sb: Sb, companyId: number): Promise<{ ok: true; facts: CardPayoutFacts } | { ok: false; reason: string }> {
  const read = <T>(table: string, cols: string) => paginateAll<T>((f, t) => sb.from(table).select(cols).eq('company_id', companyId).order('id').range(f, t));
  const [matches, rows, batches, receipts, dayCharges] = await Promise.all([
    read<CardPayoutFacts['matches'][number]>('acc_settlement_matches', 'payment_source, payment_id, settlement_row_id'),
    read<CardPayoutFacts['rows'][number]>('acc_settlement_rows', 'id, batch_id, confirmed_at'),
    read<CardPayoutFacts['batches'][number]>('acc_settlement_batches', 'id, stated_net_sen, net_sen'),
    read<CardPayoutFacts['receipts'][number]>('acc_settlement_receipts', 'batch_id, received_on, amount_sen, charge_sen, je_no'),
    read<NonNullable<CardPayoutFacts['dayCharges']>[number]>('acc_settlement_payout_batches', 'batch_id, charge_sen, charge_je_no'),
  ]);
  for (const [name, r] of [['matches', matches], ['lines', rows], ['statements', batches], ['credits', receipts], ['advice days', dayCharges]] as const) {
    if (r.error) return { ok: false, reason: `card settlement ${name}: ${String((r.error as { message?: string }).message ?? r.error)}` };
  }
  return {
    ok: true,
    facts: {
      matches: matches.data ?? [], rows: rows.data ?? [], batches: batches.data ?? [], receipts: receipts.data ?? [],
      dayCharges: (dayCharges.data ?? []).map((d) => ({ batch_id: Number(d.batch_id), charge_sen: d.charge_sen == null ? null : Number(d.charge_sen), charge_je_no: d.charge_je_no ?? null })),
    },
  };
}
