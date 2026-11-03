/* The document a journal entry was written from (batch 6, owner question g3:
   the card of a document's entry opens its document instead of posting).
   Pinned: an invoice, a voucher and a note are read back from their number to
   the id their page opens by; a payment opens the order or the invoice it sits
   on; a reversal opens its original's document; another company's row is never
   found; an entry with no document (a stock close, a manual journal) has none;
   a failed read is a refusal, never a blank. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { resolveJournalDocument } from './journal-document';

const CO = 2;
const world = () => fakeSb({
  sales_invoices: [
    { id: 'si-1', company_id: CO, invoice_number: '2990-SI-2609-001' },
    { id: 'si-other', company_id: 1, invoice_number: 'HC-SI-2609-001' },
  ],
  purchase_invoices: [{ id: 'pi-1', company_id: CO, invoice_number: '2990-PI-2607-001' }],
  ap_invoices: [{ id: 'api-1', company_id: CO, invoice_number: '2990-API-2602-001' }],
  payment_vouchers: [{ id: 'pv-1', company_id: CO, pv_number: '2990-HPV-2608-017' }],
  acc_credit_notes: [
    { id: 'cn-1', company_id: CO, note_number: '2990-CN-2609-001' },
    { id: 'scn-1', company_id: CO, note_number: '2990-SCN-2610-002' },
  ],
  mfg_sales_order_payments: [{ id: 'pay-1', company_id: CO, so_doc_no: '2990-SO-2606-014' }],
  sales_invoice_payments: [{ id: 'sip-1', company_id: CO, sales_invoice_id: 'si-1' }],
});

describe('resolveJournalDocument', () => {
  test('a document by its number: the id its page opens by', async () => {
    const sb = world();
    expect(await resolveJournalDocument(sb, CO, 'SI', '2990-SI-2609-001')).toEqual({ ok: true, document: { kind: 'SI', id: 'si-1', number: '2990-SI-2609-001' } });
    expect(await resolveJournalDocument(sb, CO, 'PI', '2990-PI-2607-001')).toEqual({ ok: true, document: { kind: 'PI', id: 'pi-1', number: '2990-PI-2607-001' } });
    expect(await resolveJournalDocument(sb, CO, 'API', '2990-API-2602-001')).toEqual({ ok: true, document: { kind: 'API', id: 'api-1', number: '2990-API-2602-001' } });
    expect(await resolveJournalDocument(sb, CO, 'PV', '2990-HPV-2608-017')).toEqual({ ok: true, document: { kind: 'PV', id: 'pv-1', number: '2990-HPV-2608-017' } });
    expect(await resolveJournalDocument(sb, CO, 'CN', '2990-CN-2609-001')).toEqual({ ok: true, document: { kind: 'NOTE', id: 'cn-1', number: '2990-CN-2609-001' } });
    expect(await resolveJournalDocument(sb, CO, 'SCN', '2990-SCN-2610-002')).toEqual({ ok: true, document: { kind: 'SUPPLIER_NOTE', id: 'scn-1', number: '2990-SCN-2610-002' } });
  });

  test('a payment opens what it sits on; a reversal opens its original’s document', async () => {
    const sb = world();
    expect(await resolveJournalDocument(sb, CO, 'SOPAY', 'pay-1')).toEqual({ ok: true, document: { kind: 'SO', id: '2990-SO-2606-014', number: '2990-SO-2606-014' } });
    expect(await resolveJournalDocument(sb, CO, 'SOPAY_REVERSAL', 'pay-1')).toEqual({ ok: true, document: { kind: 'SO', id: '2990-SO-2606-014', number: '2990-SO-2606-014' } });
    expect(await resolveJournalDocument(sb, CO, 'SIPAY', 'sip-1')).toEqual({ ok: true, document: { kind: 'SI', id: 'si-1', number: '2990-SI-2609-001' } });
    expect(await resolveJournalDocument(sb, CO, 'PV_REVERSAL', '2990-HPV-2608-017')).toEqual({ ok: true, document: { kind: 'PV', id: 'pv-1', number: '2990-HPV-2608-017' } });
  });

  test('another company’s row is not found; an entry with no document has none', async () => {
    const sb = world();
    expect(await resolveJournalDocument(sb, CO, 'SI', 'HC-SI-2609-001')).toEqual({ ok: true, document: null });
    expect(await resolveJournalDocument(sb, CO, 'STOCKADJ', 'STOCKADJ-2-2026-09')).toEqual({ ok: true, document: null });
    expect(await resolveJournalDocument(sb, CO, 'MANUAL', null)).toEqual({ ok: true, document: null });
    expect(await resolveJournalDocument(sb, CO, 'SOPAY', 'pay-gone')).toEqual({ ok: true, document: null });
  });

  test('a failed read is a refusal, never a blank', async () => {
    const broken = fakeSb({ sales_invoices: [] as Row[] }, { sales_invoices: ['invoice_number'] });
    const r = await resolveJournalDocument(broken, CO, 'SI', '2990-SI-2609-001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sales_invoices/);
  });
});
