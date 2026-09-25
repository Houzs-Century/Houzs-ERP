/* What a journal entry is called on a screen (owner 2026-09-15, docs/bugs/0918:
   我需要看到 customer name，然后 source 改成 reference 吧，就是 or number, pv number
   等等 … so number 我还是需要). Pinned: a sales-order payment names its order
   and its customer, the receipt number in front when one exists; a voucher
   its number and payee; a payout its acquirer and day; a reversal reads as
   its original; an entry the reads cannot place keeps its document number;
   a failed read is a refusal, never a blank. The general ledger's two handles
   (docs/bugs/0924): doc = the receipt or the order, the voucher, the invoice,
   "<acquirer> settlement dd/mm/yyyy", "Stock mm/yyyy"; doc2 = the order, the
   supplier's own ref, the merchant's ref, the bank ref, what a refund refunds. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { resolveJournalRefs, withJournalRefs } from './journal-refs';

const CO = 2;
const world = (over: Record<string, Row[]> = {}) => fakeSb({
  mfg_sales_order_payments: [
    { id: 'pay-1', company_id: CO, so_doc_no: '2990-SO-2606-014' },
    { id: 'pay-2', company_id: CO, so_doc_no: '2990-SO-2608-067' },
    { id: 'pay-conv', company_id: CO, so_doc_no: '2990-SO-2608-067', converted_from_so_doc_no: '2990-SO-2607-010' },
    { id: 'pay-9', company_id: 1, so_doc_no: 'HOUZS-SO-1' },   // another company's
  ],
  mfg_sales_orders: [
    { doc_no: '2990-SO-2606-014', company_id: CO, debtor_name: 'Ah Meng' },
    { doc_no: '2990-SO-2608-067', company_id: CO, debtor_name: 'NG KAH YEE' },
  ],
  acc_official_receipts: [
    { company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-2', or_number: '2990DraftOR-2608-003', status: 'DRAFT' },
  ],
  acc_settlement_batches: [{ id: 60, company_id: CO, acquirer_code: 'HLB' }, { id: 61, company_id: CO, acquirer_code: 'GHL' }],
  acc_settlement_receipts: [{ id: 54, company_id: CO, batch_id: 60, received_on: '2026-08-26', bank_ref: 'HLB-77123' }],
  acc_settlement_rows: [{ id: 103, company_id: CO, batch_id: 61, acquirer_code: 'GHL', txn_date: '2026-06-02', ref: '615318040666' }],
  acc_settlement_payout_batches: [{ id: 4, company_id: CO, batch_id: 61, settled_on: '2026-06-06' }],
  purchase_invoices: [{ company_id: CO, invoice_number: '2990-PI-2607-001', supplier_invoice_ref: 'INV-8891' }],
  ap_invoices: [{ company_id: CO, invoice_number: '2990-API-2602-001', supplier_invoice_ref: '2602/024' }],
  sales_invoices: [{ company_id: CO, invoice_number: '2990-SI-2609-001', so_doc_no: '2990-SO-2608-067', debtor_name: 'NG KAH YEE' }],
  acc_deposit_invoices: [{ company_id: CO, di_number: '2990-DI-2606-001', so_doc_no: '2990-SO-2606-014', party_name: 'Ah Meng' }],
  acc_credit_notes: [{ company_id: CO, note_number: '2990-CN-2609-001', so_doc_no: '2990-SO-2608-067', party_name: 'NG KAH YEE' }],
  payment_vouchers: [{ company_id: CO, pv_number: '2990-HPV-2608-017', payee_name: 'LOO WEN WEI', refund_source_doc_no: null }, { company_id: CO, pv_number: '2990-HPV-2606-025', payee_name: 'THE CONTS', refund_source_doc_no: '2990-HRF-2606-001' }],
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

/* The general ledger's handles, one entry per kind of document. */
const DOCS = [
  { jeNo: 'D-PI', sourceType: 'PI', sourceDocNo: '2990-PI-2607-001', partyName: 'ARMANI SOFA SDN. BHD.', notes: null },
  { jeNo: 'D-API', sourceType: 'API_REVERSAL', sourceDocNo: '2990-API-2602-001', partyName: 'YSL MANAGEMENT', notes: null },
  { jeNo: 'D-SI', sourceType: 'SI', sourceDocNo: '2990-SI-2609-001', partyName: null, notes: null },
  { jeNo: 'D-DI', sourceType: 'DI', sourceDocNo: '2990-DI-2606-001', partyName: null, notes: null },
  { jeNo: 'D-CN', sourceType: 'CN', sourceDocNo: '2990-CN-2609-001', partyName: null, notes: null },
  { jeNo: 'D-PVR', sourceType: 'PV', sourceDocNo: '2990-HPV-2606-025', partyName: null, notes: null },
  { jeNo: 'D-SET', sourceType: 'SETTLE', sourceDocNo: 'SETTLE-103', partyName: null, notes: 'GHL settlement 2026-06-02 ref 615318040666' },
  { jeNo: 'D-MOVE', sourceType: 'SETTLEMOVE', sourceDocNo: 'SETTLEMOVE-103', partyName: null, notes: null },
  { jeNo: 'D-CHG', sourceType: 'SETTLECHARGE', sourceDocNo: 'SETTLECHARGE-4', partyName: null, notes: 'PBB bank charge' },
  { jeNo: 'D-STK', sourceType: 'STOCKADJ', sourceDocNo: 'STOCKADJ-2-2026-07', partyName: null, notes: 'Closing stock 2026-07' },
  { jeNo: 'D-STKR', sourceType: 'STOCKADJ', sourceDocNo: 'STOCKADJ-REV-2-2026-08', partyName: null, notes: null },
  /* Money moved from a cancelled order (docs/bugs/0927): the new order and the one it came from. */
  { jeNo: 'D-CONV', sourceType: 'SOCONV', sourceDocNo: 'pay-conv', partyName: null, notes: 'Money on 2990-SO-2607-010 moved to 2990-SO-2608-067' },
];

describe('resolveJournalRefs', () => {
  test('names every kind of entry the way a person knows it', async () => {
    const r = await resolveJournalRefs(world(), CO, ENTRIES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const at = (je: string) => r.refs.get(je);
    /* A sales-order payment: the order always, the customer; the receipt number in front when one exists. */
    expect(at('JE-1')).toEqual({ reference: '2990-SO-2606-014', who: 'Ah Meng', doc: '2990-SO-2606-014', doc2: null });
    expect(at('JE-2')).toEqual({ reference: '2990DraftOR-2608-003 · 2990-SO-2608-067', who: 'NG KAH YEE', doc: '2990DraftOR-2608-003', doc2: '2990-SO-2608-067' });
    expect(at('JE-3')).toEqual({ reference: '2990-HPV-2608-017', who: 'LOO WEN WEI', doc: '2990-HPV-2608-017', doc2: null });
    expect(at('JE-4')).toEqual({ reference: 'HLB payout 2026/08/26', who: 'HLB', doc: 'HLB payout 2026/08/26', doc2: 'HLB-77123' });
    /* A reversal reads as its original. */
    expect(at('JE-5')).toEqual({ reference: '2990-SO-2606-014', who: 'Ah Meng', doc: '2990-SO-2606-014', doc2: null });
    /* A payment the tables no longer hold keeps its key, and the note stands in for the who. */
    expect(at('JE-6')).toEqual({ reference: 'pay-gone', who: 'a payment the tables no longer hold', doc: 'pay-gone', doc2: null });
    expect(at('JE-7')).toEqual({ reference: null, who: 'Opening balance', doc: null, doc2: null });
    expect(at('JE-8')).toEqual({ reference: '2990-OR-2604-001', who: 'HOUZS VENTURE', doc: '2990-OR-2604-001', doc2: null });
  });

  test('the general ledger\'s two handles, per kind of document (docs/bugs/0924)', async () => {
    const r = await resolveJournalRefs(world(), CO, DOCS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const at = (je: string) => { const x = r.refs.get(je); return x ? [x.doc, x.doc2, x.who] : null; };
    expect(at('D-PI')).toEqual(['2990-PI-2607-001', 'INV-8891', 'ARMANI SOFA SDN. BHD.']);
    /* A reversal reads as its original: the AP invoice's own supplier ref. */
    expect(at('D-API')).toEqual(['2990-API-2602-001', '2602/024', 'YSL MANAGEMENT']);
    expect(at('D-SI')).toEqual(['2990-SI-2609-001', '2990-SO-2608-067', 'NG KAH YEE']);
    expect(at('D-DI')).toEqual(['2990-DI-2606-001', '2990-SO-2606-014', 'Ah Meng']);
    expect(at('D-CN')).toEqual(['2990-CN-2609-001', '2990-SO-2608-067', 'NG KAH YEE']);
    /* A refund voucher: what it refunds is the second handle; the payee is the who. */
    expect(at('D-PVR')).toEqual(['2990-HPV-2606-025', '2990-HRF-2606-001', 'THE CONTS']);
    expect(at('D-SET')).toEqual(['GHL settlement 2026/06/02', '615318040666', 'GHL']);
    expect(at('D-MOVE')).toEqual(['GHL settlement 2026/06/02', '615318040666', 'GHL']);
    expect(at('D-CHG')).toEqual(['GHL charge 2026/06/06', null, 'GHL']);
    expect(at('D-STK')).toEqual(['Stock 07/2026', null, 'Closing stock 2026-07']);
    expect(at('D-STKR')).toEqual(['Stock 08/2026', null, null]);
    expect(at('D-CONV')).toEqual(['2990-SO-2608-067', '2990-SO-2607-010', 'NG KAH YEE']);
    expect(r.refs.get('D-CONV')?.reference).toBe('2990-SO-2608-067 ← 2990-SO-2607-010');
  });

  test('reads only inside the company; nothing to resolve means no read at all', async () => {
    const sb = world();
    const r = await resolveJournalRefs(sb, 1, [{ jeNo: 'X', sourceType: 'SOPAY', sourceDocNo: 'pay-1', partyName: null, notes: null }]);
    expect(r.ok && r.refs.get('X')).toEqual({ reference: 'pay-1', who: null, doc: 'pay-1', doc2: null });
    const none = await resolveJournalRefs(fakeSb({}), CO, [{ jeNo: 'Y', sourceType: 'PV', sourceDocNo: 'PV-1', partyName: 'TNB', notes: null }]);
    expect(none.ok && none.refs.get('Y')).toEqual({ reference: 'PV-1', who: 'TNB', doc: 'PV-1', doc2: null });
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
