/* Backlog A1 — a customer credit note raised from a delivery return. Pinned:
     • GET /from-return/:id prices each returned line at what the INVOICE
       charged per unit (after discount), not the return line's list price, and
       names the order and the invoice;
     • POST with deliveryReturnId links the note and each line (return line +
       units), takes the customer from the return's order and the invoice;
     • a second note for the same return line beyond the returned qty is
       refused; a cancelled note gives its units back;
     • more money than the invoice charged, a line never invoiced, a line of
       another return, a cancelled return and another company's return are
       refused;
     • a draft from a return is edited under the same rule, its own units not
       counted against it.
   Same fake-PostgREST harness as tests/creditNotes.test.ts. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';

const CO = 2;
const OTHER = 3;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});

function harness(over: Record<string, Row[]> = {}) {
  const sb = fakeSb({
    accounts: [acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }), acct('510-0000', 'RETURN INWARDS', 'INCOME')],
    acc_account_roles: [],
    mfg_sales_orders: [{ doc_no: 'HC-SO-2610-120', company_id: CO, debtor_code: null, debtor_name: 'TAN AH KOW', customer_id: 'cust-tan' }],
    delivery_orders: [{ id: 'do-1', company_id: CO, so_doc_no: 'HC-SO-2610-120' }],
    delivery_returns: [
      { id: 'dr-1', company_id: CO, return_number: 'HC-DR-2611-004', status: 'RECEIVED', delivery_order_id: 'do-1', do_doc_no: 'HC-DO-2611-010', debtor_name: 'TAN AH KOW' },
      { id: 'dr-x', company_id: OTHER, return_number: 'XX-DR-2611-001', status: 'RECEIVED', delivery_order_id: null, do_doc_no: null, debtor_name: 'X' },
    ],
    delivery_return_items: [
      /* The return line carries the SKU's list price (RM1,000); the invoice charged 900.00 each. */
      { id: 'r1', company_id: CO, delivery_return_id: 'dr-1', do_item_id: 'd1', item_code: 'BED-Q', description: 'Queen bed', qty_returned: 2, unit_price_sen: 100000, created_at: '1' },
      { id: 'r2', company_id: CO, delivery_return_id: 'dr-1', do_item_id: 'd2', item_code: 'FOC', description: 'Gift', qty_returned: 1, unit_price_sen: 0, created_at: '2' },
    ],
    sales_invoices: [
      { id: 'si-a', company_id: CO, invoice_number: 'HC-SI-2611-007', so_doc_no: 'HC-SO-2610-120', status: 'SENT', debtor_code: null, debtor_name: 'TAN AH KOW' },
      { id: 'si-c', company_id: CO, invoice_number: 'HC-SI-2611-001', so_doc_no: 'HC-SO-2610-120', status: 'CANCELLED', debtor_code: null, debtor_name: 'TAN AH KOW' },
    ],
    sales_invoice_items: [
      { id: 'sl-1', company_id: CO, sales_invoice_id: 'si-a', do_item_id: 'd1', qty: 4, line_total_sen: 360000 },
      { id: 'sl-0', company_id: CO, sales_invoice_id: 'si-c', do_item_id: 'd2', qty: 1, line_total_sen: 9900 },
    ],
    acc_credit_notes: [], acc_credit_note_lines: [],
    journal_entries: [], journal_entry_lines: [],
    ...over,
  }, {}, [], ['journal_entry_lines']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: PV_KEYS } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/credit-notes', creditNotes);
  return { app, sb };
}
const json = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const fromReturn = (lines: Array<{ deliveryReturnItemId?: string; qty?: number; amountSen: number }>) =>
  ({ kind: 'CN', deliveryReturnId: 'dr-1', noteDate: '2026-11-09', reason: 'GOODS RETURNED', lines: lines.map((l) => ({ description: 'BED-Q', ...l })) });

describe('GET /credit-notes/from-return/:id', () => {
  test('prices at the invoice, not the list price; names the order and the issued invoice', async () => {
    const { app } = harness();
    const res = await app.request('/credit-notes/from-return/dr-1');
    expect(res.status).toBe(200);
    const b = await res.json() as Row;
    expect(b.soDocNo).toBe('HC-SO-2610-120');
    expect(b.invoice).toEqual({ id: 'si-a', number: 'HC-SI-2611-007' });
    expect(b.state).toBe('AWAITING');
    expect(b.lines[0]).toMatchObject({ returnItemId: 'r1', unitSen: 90000, remainingQty: 2, capSen: 180000 });
    /* Billed only on a cancelled invoice: never invoiced. */
    expect(b.lines[1]).toMatchObject({ returnItemId: 'r2', unitSen: null, capSen: null });
  });

  test("another company's return is not found", async () => {
    const { app } = harness();
    expect((await app.request('/credit-notes/from-return/dr-x')).status).toBe(404);
  });
});

describe('POST /credit-notes from a return', () => {
  test('links the note and its lines; the customer is the order\'s; a second note past the returned qty is refused', async () => {
    const { app, sb } = harness();
    const res = await json(app, '/credit-notes', 'POST', fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 90000 }]));
    expect(res.status).toBe(201);
    const note = (await res.json() as { note: Row }).note;
    expect(note).toMatchObject({ kind: 'CN', delivery_return_id: 'dr-1', so_doc_no: 'HC-SO-2610-120', sales_invoice_id: 'si-a', source_doc_no: 'HC-DR-2611-004', party_name: 'TAN AH KOW' });
    expect(sb.tables.acc_credit_note_lines).toEqual([expect.objectContaining({ delivery_return_item_id: 'r1', qty: 1, amount_sen: 90000, account_code: '510-0000' })]);

    const over = await json(app, '/credit-notes', 'POST', fromReturn([{ deliveryReturnItemId: 'r1', qty: 2, amountSen: 180000 }]));
    expect(over.status).toBe(409);
    expect((await over.json() as Row).error).toBe('over_return_credit');
    expect((await json(app, '/credit-notes', 'POST', fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 90000 }]))).status).toBe(201);
    expect((await app.request('/credit-notes/from-return/dr-1').then((r) => r.json()) as Row).state).toBe('DRAFTED');

    /* A cancelled note gives its unit back. */
    expect((await json(app, `/credit-notes/${note.id}/cancel`, 'POST', {})).status).toBe(200);
    expect((await json(app, '/credit-notes', 'POST', fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 90000 }]))).status).toBe(201);
  });

  test('refuses more than the invoice charged, a line never invoiced, a line with no return line, and a foreign line', async () => {
    const { app, sb } = harness();
    const cases: Array<[unknown, number, string]> = [
      [fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 100000 }]), 409, 'over_invoice_price'],
      [fromReturn([{ deliveryReturnItemId: 'r2', qty: 1, amountSen: 100 }]), 409, 'return_line_not_invoiced'],
      [fromReturn([{ amountSen: 100 }]), 400, 'return_line_required'],
      [fromReturn([{ deliveryReturnItemId: 'zz', qty: 1, amountSen: 100 }]), 409, 'return_line_unknown'],
      [{ ...fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 100 }]), kind: 'DN' }, 400, 'return_not_this_kind'],
      [{ ...fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 100 }]), deliveryReturnId: 'dr-x' }, 400, 'return_unknown'],
      [{ kind: 'CN', soDocNo: 'HC-SO-2610-120', noteDate: '2026-11-09', lines: [{ amountSen: 100, deliveryReturnItemId: 'r1', qty: 1 }] }, 400, 'return_required'],
    ];
    for (const [body, status, error] of cases) {
      const res = await json(app, '/credit-notes', 'POST', body);
      expect({ status: res.status, error: (await res.json() as Row).error }).toEqual({ status, error });
    }
    expect(sb.tables.acc_credit_notes).toHaveLength(0);
  });

  test('a cancelled return takes no credit note', async () => {
    const { app, sb } = harness();
    (sb.tables.delivery_returns as Row[])[0]!.status = 'CANCELLED';
    const res = await json(app, '/credit-notes', 'POST', fromReturn([{ deliveryReturnItemId: 'r1', qty: 1, amountSen: 90000 }]));
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('return_cancelled');
  });

  test('a draft from a return is edited under the same rule, its own units not counted twice', async () => {
    const { app, sb } = harness();
    const made = await json(app, '/credit-notes', 'POST', fromReturn([{ deliveryReturnItemId: 'r1', qty: 2, amountSen: 180000 }]));
    const id = ((await made.json()) as { note: Row }).note.id;
    const cut = await json(app, `/credit-notes/${id}`, 'PATCH', { lines: [{ description: 'BED-Q', deliveryReturnItemId: 'r1', qty: 1, amountSen: 90000 }] });
    expect(cut.status).toBe(200);
    expect(sb.tables.acc_credit_note_lines).toEqual([expect.objectContaining({ delivery_return_item_id: 'r1', qty: 1, amount_sen: 90000 })]);
    const over = await json(app, `/credit-notes/${id}`, 'PATCH', { lines: [{ description: 'BED-Q', deliveryReturnItemId: 'r1', qty: 3, amountSen: 90000 }] });
    expect(over.status).toBe(409);
    const unlinked = await json(app, `/credit-notes/${id}`, 'PATCH', { lines: [{ description: 'goodwill', amountSen: 100 }] });
    expect((await unlinked.json() as Row).error).toBe('return_line_required');
  });
});
