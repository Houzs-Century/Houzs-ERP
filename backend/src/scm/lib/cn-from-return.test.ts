import { describe, expect, it } from 'vitest';
import { checkReturnLines, creditNoteHold, isIssuedInvoice, lineCapSen, pickInvoice, priceReturnLines, returnCreditState, type InvoiceLineIn, type ReturnLineIn } from './cn-from-return';

const R1: ReturnLineIn = { id: 'r1', do_item_id: 'd1', item_code: 'BED-Q', description: 'Queen bed', qty_returned: 2 };
const R2: ReturnLineIn = { id: 'r2', do_item_id: 'd2', item_code: 'PIL', description: 'Pillow', qty_returned: 1 };
const R3: ReturnLineIn = { id: 'r3', do_item_id: 'd3', item_code: 'FOC', description: 'Never invoiced', qty_returned: 1 };

/* d1 billed 4 units for 3,600.00 after a RM400 whole-line discount: 900.00 each,
   not the list price on the return line. d2 billed on a second invoice. */
const SI: InvoiceLineIn[] = [
  { sales_invoice_id: 'si-a', do_item_id: 'd1', qty: 4, line_total_sen: 360000 },
  { sales_invoice_id: 'si-a', do_item_id: 'd2', qty: 1, line_total_sen: 5000 },
  { sales_invoice_id: 'si-b', do_item_id: 'd2', qty: 0, line_total_sen: 0 },
];

describe('priceReturnLines', () => {
  it('prices each returned unit at the invoice line total per unit, after discount', () => {
    const [p1, p2, p3] = priceReturnLines([R1, R2, R3], SI, new Map());
    expect(p1!.unitSen).toBe(90000);
    expect(lineCapSen(p1!.unitSen!, 2)).toBe(180000);
    expect(p2!.unitSen).toBe(5000);
    expect(p2!.invoiceIds).toEqual(['si-a']);
    expect(p3!.unitSen).toBeNull();
  });

  it('takes units already on live notes off what is left', () => {
    const [p1] = priceReturnLines([R1], SI, new Map([['r1', 1]]));
    expect(p1!.creditedQty).toBe(1);
    expect(p1!.remainingQty).toBe(1);
  });

  it('weights a DO line billed across two invoices', () => {
    const [p] = priceReturnLines([R1], [
      { sales_invoice_id: 'a', do_item_id: 'd1', qty: 1, line_total_sen: 1000 },
      { sales_invoice_id: 'b', do_item_id: 'd1', qty: 2, line_total_sen: 1001 },
    ], new Map());
    expect(p!.unitSen).toBeCloseTo(2001 / 3);
    expect(lineCapSen(p!.unitSen!, 3)).toBe(2001);
  });
});

describe('pickInvoice', () => {
  it('chooses the invoice that billed most lines', () => {
    expect(pickInvoice(priceReturnLines([R1, R2, R3], SI, new Map()))).toBe('si-a');
    expect(pickInvoice(priceReturnLines([R3], SI, new Map()))).toBeNull();
  });
});

describe('isIssuedInvoice', () => {
  it('counts only issued invoices', () => {
    expect(['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].every(isIssuedInvoice)).toBe(true);
    expect(['DRAFT', 'CANCELLED', 'VOID', '', null].some((s) => isIssuedInvoice(s))).toBe(false);
  });
});

describe('returnCreditState', () => {
  it('says awaiting until every invoiced unit is on a live note', () => {
    expect(returnCreditState(priceReturnLines([R3], SI, new Map()), [])).toBe('NOT_INVOICED');
    expect(returnCreditState(priceReturnLines([R1, R3], SI, new Map()), [])).toBe('AWAITING');
    expect(returnCreditState(priceReturnLines([R1], SI, new Map([['r1', 1]])), ['DRAFT'])).toBe('AWAITING');
    expect(returnCreditState(priceReturnLines([R1, R3], SI, new Map([['r1', 2]])), ['DRAFT', 'POSTED'])).toBe('DRAFTED');
    expect(returnCreditState(priceReturnLines([R1], SI, new Map([['r1', 2]])), ['POSTED'])).toBe('ISSUED');
  });
});

describe('checkReturnLines', () => {
  const priced = priceReturnLines([R1, R2, R3], SI, new Map([['r1', 1]]));
  it('accepts units still uncredited at no more than the invoice price', () => {
    expect(checkReturnLines(priced, [{ returnItemId: 'r1', qty: 1, amountSen: 90000 }, { returnItemId: 'r2', qty: 1, amountSen: 4000 }])).toBeNull();
  });
  it('refuses a second credit beyond the returned qty', () => {
    expect(checkReturnLines(priced, [{ returnItemId: 'r1', qty: 2, amountSen: 1 }])?.error).toBe('over_return_credit');
  });
  it('refuses more money than the invoice charged', () => {
    expect(checkReturnLines(priced, [{ returnItemId: 'r1', qty: 1, amountSen: 90001 }])?.error).toBe('over_invoice_price');
  });
  it('refuses a line never invoiced, a foreign line, a repeated line and a bad qty', () => {
    expect(checkReturnLines(priced, [{ returnItemId: 'r3', qty: 1, amountSen: 1 }])?.error).toBe('return_line_not_invoiced');
    expect(checkReturnLines(priced, [{ returnItemId: 'zz', qty: 1, amountSen: 1 }])?.error).toBe('return_line_unknown');
    expect(checkReturnLines(priced, [{ returnItemId: 'r2', qty: 1, amountSen: 1 }, { returnItemId: 'r2', qty: 1, amountSen: 1 }])?.error).toBe('return_line_twice');
    expect(checkReturnLines(priced, [{ returnItemId: 'r2', qty: 0.5, amountSen: 1 }])?.error).toBe('bad_line');
  });
});

/* A minimal PostgREST double: the two reads creditNoteHold makes, each asserting
   the company predicate is on the query. */
function fakeSb(tables: Record<string, Array<Record<string, unknown>>>, fail: string | null = null) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let inCol = ''; let inVals: unknown[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a chainable PostgREST double
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => { filters.push([col, v]); return q; },
        in: (col: string, vals: unknown[]) => { inCol = col; inVals = vals; return q; },
        order: () => q,
        range: () => {
          if (table === fail) return Promise.resolve({ data: null, error: { message: 'boom' } });
          expect(filters).toContainEqual(['company_id', 7]);
          const rows = (tables[table] ?? []).filter((r) => inVals.includes(r[inCol]) && filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
}

describe('creditNoteHold', () => {
  const tables = {
    acc_credit_note_lines: [
      { company_id: 7, note_id: 'n1', delivery_return_item_id: 'r1', qty: 2 },
      { company_id: 7, note_id: 'n2', delivery_return_item_id: 'r1', qty: 5 },
    ],
    acc_credit_notes: [
      { company_id: 7, id: 'n1', status: 'POSTED' },
      { company_id: 7, id: 'n2', status: 'CANCELLED' },
    ],
  };
  it('refuses cutting a line below what live notes credit, ignoring cancelled notes', async () => {
    expect(await creditNoteHold(fakeSb(tables), 7, [{ itemId: 'r1', qty: 2 }])).toBeNull();
    expect((await creditNoteHold(fakeSb(tables), 7, [{ itemId: 'r1', qty: 1 }]))?.error).toBe('dr_credit_noted');
  });
  it('refuses when it cannot read, never reads a failure as nothing credited', async () => {
    expect((await creditNoteHold(fakeSb(tables, 'acc_credit_notes'), 7, [{ itemId: 'r1', qty: 0 }]))?.status).toBe(503);
  });
});
