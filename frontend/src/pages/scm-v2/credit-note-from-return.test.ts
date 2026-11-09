/* Backlog A1: a credit note from a delivery return is filled at the INVOICED
   price, one line per returned line still uncredited, and its body carries the
   return links the server holds against the returned units. */

import { describe, expect, test } from 'vitest';
import type { ReturnCreditPrefill } from '../../vendor/scm/lib/credit-note-queries';
import { bodyOf, noteEditValues } from './CreditNotes';
import { fromReturnValues, nothingToCredit, skippedReturnLines } from './credit-note-from-return';
import { RETURN_CREDIT_LABEL, returnCreditLabel } from '../../vendor/scm/lib/return-credit-state';

const PREFILL: ReturnCreditPrefill = {
  deliveryReturn: { id: 'dr-1', returnNumber: 'HC-DR-2611-004', status: 'RECEIVED', doDocNo: 'HC-DO-2611-010', customer: 'TAN AH KOW' },
  soDocNo: 'HC-SO-2610-120',
  invoice: { id: 'si-a', number: 'HC-SI-2611-007' },
  lines: [
    /* List price RM1,000 on the SKU; the invoice charged 900.00 each after a discount. */
    { returnItemId: 'r1', itemCode: 'BED-Q', description: 'Queen bed', qtyReturned: 2, creditedQty: 0, remainingQty: 2, unitSen: 90000, invoiceIds: ['si-a'], capSen: 180000 },
    { returnItemId: 'r2', itemCode: 'PIL', description: 'Pillow', qtyReturned: 1, creditedQty: 1, remainingQty: 0, unitSen: 5000, invoiceIds: ['si-a'], capSen: 0 },
    { returnItemId: 'r3', itemCode: 'FOC', description: null, qtyReturned: 1, creditedQty: 0, remainingQty: 1, unitSen: null, invoiceIds: [], capSen: null },
  ],
  notes: [{ id: 'n1', number: 'HC-CN-2611-001', status: 'DRAFT', totalSen: 5000 }],
  state: 'AWAITING',
};

describe('fromReturnValues', () => {
  test('fills a customer note from the return at the invoiced price', () => {
    const v = fromReturnValues(PREFILL);
    expect(v.kind).toBe('CN');
    expect(v.soDocNo).toBe('HC-SO-2610-120');
    expect(v.sourceDocNo).toBe('HC-DR-2611-004');
    expect(v.deliveryReturnId).toBe('dr-1');
    expect(v.invoiceNumber).toBe('HC-SI-2611-007');
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toMatchObject({ description: 'BED-Q QUEEN BED', amountRm: '1800.00', ret: { itemId: 'r1', qty: 2, maxQty: 2, unitSen: 90000 } });
  });

  test('the body names the return and each line its return line and units', () => {
    const body = bodyOf(fromReturnValues(PREFILL));
    expect(body.deliveryReturnId).toBe('dr-1');
    expect(body.soDocNo).toBe('HC-SO-2610-120');
    expect(body.lines).toEqual([{ description: 'BED-Q QUEEN BED', accountCode: null, amountSen: 180000, deliveryReturnItemId: 'r1', qty: 2 }]);
  });

  test('a note with no return sends no return fields', () => {
    const body = bodyOf({ kind: 'CN', noteDate: '2026-11-09', soDocNo: 'SO-1', partyName: '', supplierId: '', sourceDocNo: '', reason: '', lines: [{ rid: 1, description: 'X', accountCode: '', amountRm: '10', projectId: null }] });
    expect(body.deliveryReturnId).toBeUndefined();
    expect(body.lines[0]).not.toHaveProperty('deliveryReturnItemId');
  });

  test('a draft from a return opened for edit keeps its links', () => {
    const v = noteEditValues(
      { id: 'n1', note_number: 'HC-CN-2611-001', kind: 'CN', party_type: 'CUSTOMER', party_code: null, party_name: 'TAN AH KOW', supplier_id: null, so_doc_no: 'HC-SO-2610-120',
        sales_invoice_id: 'si-a', ap_invoice_id: null, purchase_invoice_id: null, source_doc_no: 'HC-DR-2611-004', note_date: '2026-11-09', total_sen: 5000, reason: null, notes: null,
        status: 'DRAFT', je_no: null, created_at: '', created_by: null, posted_at: null, cancelled_at: null, delivery_return_id: 'dr-1' },
      [{ id: 'l1', line_no: 1, description: 'PIL', account_code: '510-0000', amount_sen: 5000, delivery_return_item_id: 'r2', qty: 1 }],
      [],
    );
    expect(v.deliveryReturnId).toBe('dr-1');
    expect(bodyOf(v).lines[0]).toMatchObject({ deliveryReturnItemId: 'r2', qty: 1, amountSen: 5000 });
  });
});

describe('what is left off, and why', () => {
  test('names lines never invoiced or already credited', () => {
    expect(skippedReturnLines(PREFILL)).toEqual(['PIL: all 1 already credited', 'FOC: never invoiced']);
    expect(nothingToCredit(PREFILL)).toBeNull();
  });
  test('says why there is nothing to credit', () => {
    const done = { ...PREFILL, lines: PREFILL.lines.filter((l) => l.returnItemId === 'r2') };
    expect(nothingToCredit(done)).toBe('Every invoiced unit of HC-DR-2611-004 is already on a credit note (HC-CN-2611-001).');
    expect(nothingToCredit({ ...PREFILL, lines: PREFILL.lines.filter((l) => l.returnItemId === 'r3') })).toMatch(/never invoiced/);
    expect(nothingToCredit({ ...PREFILL, deliveryReturn: { ...PREFILL.deliveryReturn, status: 'CANCELLED' } })).toMatch(/cancelled/);
  });
});

describe('returnCreditLabel', () => {
  test('reads the server state, blank for anything else', () => {
    expect(returnCreditLabel('AWAITING')).toBe('Awaiting credit note');
    expect(returnCreditLabel('ISSUED')).toBe(RETURN_CREDIT_LABEL.ISSUED);
    expect(returnCreditLabel(undefined)).toBe('');
    expect(returnCreditLabel('toString')).toBe('');
  });
});
