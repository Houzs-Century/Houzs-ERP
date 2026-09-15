/* What a journal entry is called on a screen (owner 2026-09-15, docs/bugs/0918:
   我需要看到 customer name，然后 source 改成 reference 吧，就是 or number, pv number
   等等 … so number 我还是需要). Pinned: a sales-order payment names its order
   and its customer, the receipt number in front when one exists; a voucher
   its number and payee; a payout its acquirer and day; a reversal reads as
   its original; an entry the reads cannot place keeps its document number;
   a failed read is a refusal, never a blank. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { resolveJournalRefs, withJournalRefs } from './journal-refs';

const CO = 2;
const world = (over: Record<string, Row[]> = {}) => fakeSb({
  mfg_sales_order_payments: [
    { id: 'pay-1', company_id: CO, so_doc_no: '2990-SO-2606-014' },
    { id: 'pay-2', company_id: CO, so_doc_no: '2990-SO-2608-067' },
    { id: 'pay-9', company_id: 1, so_doc_no: 'HOUZS-SO-1' },   // another company's
  ],
  mfg_sales_orders: [
    { doc_no: '2990-SO-2606-014', company_id: CO, debtor_name: 'Ah Meng' },
    { doc_no: '2990-SO-2608-067', company_id: CO, debtor_name: 'NG KAH YEE' },
  ],
  acc_official_receipts: [
    { company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-2', or_number: '2990DraftOR-2608-003', status: 'DRAFT' },
  ],
  acc_settlement_batches: [{ id: 60, company_id: CO, acquirer_code: 'HLB' }],
  acc_settlement_receipts: [{ id: 54, company_id: CO, batch_id: 60, received_on: '2026-08-26' }],
  ...over,
});

const ENTRIES = [
  { jeNo: 'JE-1', sourceType: 'SOPAY', sourceDocNo: 'pay-1', partyName: null, notes: 'Payment received (transfer) — 2990-SO-2606-014' },
  { jeNo: 'JE-2', sourceType: 'SOPAY', sourceDocNo: 'pay-2', partyName: null, notes: null },
  { jeNo: 'JE-3', sourceType: 'PV', sourceDocNo: '2990-HPV-2608-017', partyName: 'LOO WEN WEI', notes: null },
  { jeNo: 'JE-4', sourceType: 'SETTLEBANK', sourceDocNo: 'SETTLEBANK-60-54', partyName: null, notes: 'HLB payout received 2026-08-26 — 1499.00' },
  { jeNo: 'JE-5', sourceType: 'SOPAY_REVERSAL', sourceDocNo: 'pay-1', partyName: null, notes: 'Reversal of JE-1 — payment on 2990-SO-2606-014 deleted' },
  { jeNo: 'JE-6', sourceType: 'SOPAY', sourceDocNo: 'pay-gone', partyName: null, notes: 'a payment the tables no longer hold' },
  { jeNo: 'JE-7', sourceType: 'MANUAL', sourceDocNo: null, partyName: null, notes: 'Opening balance' },
  { jeNo: 'JE-8', sourceType: 'RCT', sourceDocNo: '2990-OR-2604-001', partyName: 'HOUZS VENTURE', notes: null },
];

describe('resolveJournalRefs', () => {
  test('names every kind of entry the way a person knows it', async () => {
    const r = await resolveJournalRefs(world(), CO, ENTRIES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const at = (je: string) => r.refs.get(je);
    /* A sales-order payment: the order always, the customer; the receipt number in front when one exists. */
    expect(at('JE-1')).toEqual({ reference: '2990-SO-2606-014', who: 'Ah Meng' });
    expect(at('JE-2')).toEqual({ reference: '2990DraftOR-2608-003 · 2990-SO-2608-067', who: 'NG KAH YEE' });
    expect(at('JE-3')).toEqual({ reference: '2990-HPV-2608-017', who: 'LOO WEN WEI' });
    expect(at('JE-4')).toEqual({ reference: 'HLB payout 26/08/2026', who: 'HLB' });
    /* A reversal reads as its original. */
    expect(at('JE-5')).toEqual({ reference: '2990-SO-2606-014', who: 'Ah Meng' });
    /* A payment the tables no longer hold keeps its key, and the note stands in for the who. */
    expect(at('JE-6')).toEqual({ reference: 'pay-gone', who: 'a payment the tables no longer hold' });
    expect(at('JE-7')).toEqual({ reference: null, who: 'Opening balance' });
    expect(at('JE-8')).toEqual({ reference: '2990-OR-2604-001', who: 'HOUZS VENTURE' });
  });

  test('reads only inside the company; nothing to resolve means no read at all', async () => {
    const sb = world();
    const r = await resolveJournalRefs(sb, 1, [{ jeNo: 'X', sourceType: 'SOPAY', sourceDocNo: 'pay-1', partyName: null, notes: null }]);
    expect(r.ok && r.refs.get('X')).toEqual({ reference: 'pay-1', who: null });
    const none = await resolveJournalRefs(fakeSb({}), CO, [{ jeNo: 'Y', sourceType: 'PV', sourceDocNo: 'PV-1', partyName: 'TNB', notes: null }]);
    expect(none.ok && none.refs.get('Y')).toEqual({ reference: 'PV-1', who: 'TNB' });
  });

  test('withJournalRefs writes the two onto the entries; a failed read refuses rather than blanks', async () => {
    const named = await withJournalRefs(world(), CO, ENTRIES.slice(0, 2).map((e) => ({ ...e, entryDate: '2026-08-05', debitSen: 187000, creditSen: 0 })));
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.entries[0]).toMatchObject({ jeNo: 'JE-1', entryDate: '2026-08-05', reference: '2990-SO-2606-014', who: 'Ah Meng' });
    const broken = await withJournalRefs(fakeSb({ mfg_sales_order_payments: [] }, { mfg_sales_order_payments: ['so_doc_no'] }), CO, ENTRIES.slice(0, 1));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toMatch(/payments/);
  });
});
