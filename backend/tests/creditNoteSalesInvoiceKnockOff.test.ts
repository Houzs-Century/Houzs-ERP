/* A customer's credit note knocks off the customer's sales invoices (owner
   2026-11-03: 「要」 — his design, "like AutoCount"; batch 5 spec c6 / f2).
   Pinned:
     • a new note's table is the customer's open invoices — by its AR party:
       the shared cash debtor 300-C002 matches WITH the name, a customer id on
       its own, no code by the name among invoices with no code — each owing
       its total less its receipts, its order's deposit and other notes;
     • the ticks ride the draft as a plan, the post carries them out and posts
       NOTHING more than the note's own journal; paid_sen is untouched (the
       overpayment rule) and the invoice's status follows;
     • the lowered outstanding reaches Money in › Invoices and Outstanding;
     • a posted note's knock-off is set whole — untick gives it back;
     • the refusals: over the note, over the invoice's outstanding (after its
       deposit and the other notes), another customer's invoice on the same
       code, another company's invoice or order, a debit note, the poster's key;
     • a deposit paper — the note that closed a deposit invoice at the final
       invoice, a refund's note — knocks nothing off, and a close-out is listed
       on its invoice without lowering it twice;
     • a cancelled note gives its knock-off back; a cancelled invoice gives the
       credit back to its notes; at post an invoice paid meanwhile takes only
       what it owes. */

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';
import { arInvoices } from '../src/scm/routes/ar-invoices';
import { outstanding } from '../src/scm/routes/outstanding';
import { releaseSalesInvoiceKnockOffs, sameCustomer } from '../src/acc/credit-note-si';
import { siCreditNotesSen } from '../src/scm/lib/si-credit-notes';

const CO = 1;
const KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
/* A customer id, as 2990 (and a few Houzs orders) carry one. */
const AMINAH = '6f1d2b3c-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const order = (doc: string, code: string | null, name: string, over: Row = {}): Row => ({
  doc_no: doc, company_id: CO, debtor_code: code, debtor_name: name, customer_id: null, total_revenue_sen: 0, deposit_sen: 0, status: 'DELIVERED', ...over,
});
const invoice = (id: string, number: string, so: string, code: string | null, name: string, total: number, over: Row = {}): Row => ({
  id, company_id: CO, invoice_number: number, so_doc_no: so, debtor_code: code, debtor_name: name, invoice_date: '2026-10-05', due_date: '2026-11-04',
  total_sen: total, paid_sen: 0, status: 'SENT', ...over,
});

function harness(perms: readonly string[] = KEYS) {
  const tables: Record<string, Row[]> = {
    accounts: [
      acct('300-0000', 'TRADE DEBTORS', 'ASSET', { special_type: 'SDC' }),
      acct('510-0000', 'RETURN INWARDS', 'INCOME'),
      acct('520-0000', 'DISCOUNT ALLOWED', 'INCOME'),
    ],
    acc_account_roles: [],
    mfg_sales_orders: [
      /* Tan Ah Kow, a walk-in on the shared cash debtor, RM 1,000 down on RM 5,000. */
      order('HC-SO-2610-001', '300-C002', 'Tan Ah Kow', { total_revenue_sen: 500_000 }),
      /* Another walk-in on the same code. */
      order('HC-SO-2610-002', '300-C002', 'Lee Mei Ling', { total_revenue_sen: 200_000 }),
      /* A Tan Ah Kow with no code at all — another AR party. */
      order('HC-SO-2610-003', null, 'Tan Ah Kow', { total_revenue_sen: 80_000 }),
      /* One customer by id, named two ways on two orders. */
      order('HC-SO-2610-004', null, 'Siti Aminah', { customer_id: AMINAH, total_revenue_sen: 300_000 }),
      order('HC-SO-2610-005', null, 'Siti Aminah binti Ali', { customer_id: AMINAH, total_revenue_sen: 100_000 }),
      order('2990-SO-2610-001', '300-C002', 'Tan Ah Kow', { company_id: 2, total_revenue_sen: 50_000 }),
    ],
    mfg_sales_order_payments: [
      { id: 'pay-1', so_doc_no: 'HC-SO-2610-001', paid_at: '2026-10-01', method: 'cash', amount_sen: 100_000, account_sheet: 'Cash', note: null, is_deposit: true },
    ],
    sales_invoices: [
      invoice('si-tan', 'HC-SI-2610-001', 'HC-SO-2610-001', '300-C002', 'Tan Ah Kow', 500_000),
      invoice('si-lee', 'HC-SI-2610-002', 'HC-SO-2610-002', '300-C002', 'Lee Mei Ling', 200_000),
      invoice('si-tan-nocode', 'HC-SI-2610-003', 'HC-SO-2610-003', null, 'Tan Ah Kow', 80_000),
      invoice('si-ami-1', 'HC-SI-2610-004', 'HC-SO-2610-004', null, 'Siti Aminah', 300_000, { invoice_date: '2026-10-06' }),
      invoice('si-ami-2', 'HC-SI-2610-005', 'HC-SO-2610-005', null, 'Siti Aminah binti Ali', 100_000, { invoice_date: '2026-10-07' }),
      invoice('si-draft', 'HC-SI-2610-006', 'HC-SO-2610-001', '300-C002', 'Tan Ah Kow', 10_000, { status: 'DRAFT' }),
      invoice('si-co2', '2990-SI-2610-001', '2990-SO-2610-001', '300-C002', 'Tan Ah Kow', 50_000, { company_id: 2 }),
    ],
    sales_invoice_payments: [],
    acc_deposit_invoices: [],
    customer_credits: [],
    acc_credit_notes: [], acc_credit_note_lines: [], acc_credit_note_allocations: [], acc_credit_note_files: [],
    journal_entries: [], journal_entry_lines: [],
  };
  const sb = fakeSb(tables, {}, [], ['journal_entry_lines']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS' }] as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    await next();
  });
  app.route('/credit-notes', creditNotes);
  app.route('/ar-invoices', arInvoices);
  app.route('/outstanding', outstanding);
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Row };
  };
  const si = (id: string) => sb.tables.sales_invoices!.find((r) => r.id === id)!;
  return { req, sb, si };
}

type Req = ReturnType<typeof harness>['req'];
const CN = (over: Row = {}) => ({
  kind: 'CN', soDocNo: 'HC-SO-2610-001', noteDate: '2026-10-20', reason: 'Scratched headboard', lines: [{ description: 'Goodwill', amountSen: 30_000 }], ...over,
});
const tick = (id: string, amountSen: number) => ({ kind: 'SI', id, amountSen });
const raise = async (req: Req, body: Row) => {
  const res = await req('/credit-notes', 'POST', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.note as Row;
};
const table = (body: Row) => (body.rows as Row[]).map((r) => [r.number, r.owedSen, r.noteSen]);
const arRow = async (req: Req, number: string) => ((await req('/ar-invoices?kind=SI')).body.rows as Row[]).find((r) => r.invoiceNumber === number)!;

describe("a new note's table — the customer's open invoices, by their AR party", () => {
  test('the shared cash code matches with the name; the deposit comes off what each owes', async () => {
    const { req } = harness();
    const fresh = await req('/credit-notes/knock-off?so=HC-SO-2610-001');
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    /* Not Lee Mei Ling's (same code, another name), not the no-code Tan's, not the draft. */
    expect(table(fresh.body)).toEqual([['HC-SI-2610-001', 400_000, 0]]);
    expect((fresh.body.rows as Row[])[0]).toMatchObject({ kind: 'SI', invoiceRef: 'HC-SO-2610-001', totalSen: 500_000 });
  });

  test('a customer id finds the customer however the order named them; no code matches by the name among invoices with none', async () => {
    const { req } = harness();
    expect(table((await req('/credit-notes/knock-off?so=HC-SO-2610-004')).body)).toEqual([['HC-SI-2610-004', 300_000, 0], ['HC-SI-2610-005', 100_000, 0]]);
    expect(table((await req('/credit-notes/knock-off?so=HC-SO-2610-003')).body)).toEqual([['HC-SI-2610-003', 80_000, 0]]);
    expect(table((await req(`/credit-notes/knock-off?customer=${encodeURIComponent('  tan ah   KOW ')}`)).body)).toEqual([['HC-SI-2610-003', 80_000, 0]]);
  });

  test("another company's order is not one of this company's", async () => {
    const { req } = harness();
    const other = await req('/credit-notes/knock-off?so=2990-SO-2610-001');
    expect(other.status).toBe(400);
    expect(other.body.error).toBe('so_unknown');
  });

  test('one customer: the same code, and the same name unless the code is a customer id', () => {
    expect(sameCustomer({ code: '300-C002', name: 'Tan Ah Kow' }, { code: '300-C002', name: ' tan  ah kow' })).toBe(true);
    expect(sameCustomer({ code: '300-C002', name: 'Tan Ah Kow' }, { code: '300-C002', name: 'Lee Mei Ling' })).toBe(false);
    expect(sameCustomer({ code: null, name: 'Tan Ah Kow' }, { code: '300-C002', name: 'Tan Ah Kow' })).toBe(false);
    expect(sameCustomer({ code: AMINAH, name: 'Siti Aminah' }, { code: AMINAH, name: 'Siti Aminah binti Ali' })).toBe(true);
    expect(sameCustomer({ code: null, name: '' }, { code: null, name: '' })).toBe(false);
  });
});

describe('the plan rides the draft; the post knocks the invoice off and posts nothing more', () => {
  test('one journal, paid_sen untouched, the status follows, and every screen reads the lower outstanding', async () => {
    const { req, sb, si } = harness();
    const note = await raise(req, CN({ allocations: [tick('si-tan', 30_000)] }));
    expect(String(note.note_number)).toMatch(/^HC-CN-2610-\d{3}$/);
    expect(note).toMatchObject({ party_code: '300-C002', party_name: 'Tan Ah Kow', status: 'DRAFT' });
    expect(sb.tables.acc_credit_note_allocations!.map((r) => [r.sales_invoice_id, r.amount_sen, r.applied_sen])).toEqual([['si-tan', 30_000, 0]]);
    expect((await arRow(req, 'HC-SI-2610-001')).outstandingSen).toBe(400_000);

    const posted = await req(`/credit-notes/${note.id}/post`, 'POST');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.applied).toEqual([{ kind: 'SI', id: 'si-tan', number: 'HC-SI-2610-001', appliedSen: 30_000 }]);
    expect(posted.body.notApplied).toBeUndefined();

    /* The note's own journal, and nothing else: Dr 510 / Cr the customer. */
    expect(sb.tables.journal_entries).toHaveLength(1);
    const je = sb.tables.journal_entries![0]!;
    const legs = sb.tables.journal_entry_lines!.filter((l) => l.journal_entry_id === je.id)
      .map((l) => [l.account_code, l.debit_sen, l.credit_sen, l.party_code ?? null, l.party_name ?? null]);
    expect(legs).toEqual([['510-0000', 30_000, 0, null, null], ['300-0000', 0, 30_000, '300-C002', 'Tan Ah Kow']]);

    /* Kept apart from the payments: the overpayment rule reads paid_sen alone. */
    expect(si('si-tan')).toMatchObject({ paid_sen: 0, status: 'PARTIALLY_PAID' });
    expect(sb.tables.customer_credits).toHaveLength(0);

    const t = await req(`/credit-notes/${note.id}/knock-off`);
    expect(t.body).toMatchObject({ totalSen: 30_000, takenSen: 30_000, leftSen: 0, posted: true });
    expect(table(t.body)).toEqual([['HC-SI-2610-001', 400_000, 30_000]]);

    expect(await arRow(req, 'HC-SI-2610-001')).toMatchObject({ depositAppliedSen: 100_000, creditNotesSen: 30_000, outstandingSen: 370_000 });
    sb.tables.v_si_outstanding = sb.tables.sales_invoices!.map((r) => ({
      ...r, outstanding_sen: Number(r.total_sen) - Number(r.paid_sen), is_outstanding: !['PAID', 'CANCELLED'].includes(String(r.status)) && Number(r.total_sen) > Number(r.paid_sen),
    }));
    const out = (await req('/outstanding/si')).body.rows as Row[];
    expect(out.find((r) => r.invoice_number === 'HC-SI-2610-001')).toMatchObject({ so_deposit_applied_sen: 100_000, credit_notes_sen: 30_000, outstanding_sen: 370_000 });
    expect(await siCreditNotesSen(sb, CO, 'si-tan')).toBe(30_000);

    /* The list says what it knocks off; the detail names the invoice for the print. */
    const listed = ((await req('/credit-notes?side=AR')).body.rows as Row[]).find((r) => r.id === note.id)!;
    expect(listed).toMatchObject({ appliedSen: 30_000, unusedSen: 0, depositPaper: null });
    const detail = (await req(`/credit-notes/${note.id}`)).body;
    expect(detail.allocations).toEqual([expect.objectContaining({ kind: 'SI', number: 'HC-SI-2610-001', docDate: '2026-10-05', docTotalSen: 500_000, appliedSen: 30_000 })]);
    expect(detail.depositPaper).toBeNull();
    const onInvoice = (await req('/ar-invoices/sales/si-tan/credit-notes')).body.creditNotes as Row[];
    expect(onInvoice).toEqual([expect.objectContaining({ number: note.note_number, what: 'Scratched headboard', amountSen: 30_000, closesDeposit: false })]);
  });

  test('knocked off in full the invoice reads PAID; untick gives it back; cancel gives back what is left', async () => {
    const { req, si, sb } = harness();
    const note = await raise(req, CN({ lines: [{ description: 'Return of the bed', amountSen: 450_000 }], allocations: [tick('si-tan', 400_000)] }));
    expect((await req(`/credit-notes/${note.id}/post`, 'POST')).status).toBe(200);
    expect(si('si-tan')).toMatchObject({ paid_sen: 0, status: 'PAID' });
    expect((await arRow(req, 'HC-SI-2610-001')).outstandingSen).toBe(0);
    /* Paid by this very note — still on its table to untick. */
    expect(table((await req(`/credit-notes/${note.id}/knock-off`)).body)).toEqual([['HC-SI-2610-001', 400_000, 400_000]]);

    const lower = await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [tick('si-tan', 150_000)] });
    expect(lower.status, JSON.stringify(lower.body)).toBe(200);
    expect(si('si-tan').status).toBe('PARTIALLY_PAID');
    expect((await arRow(req, 'HC-SI-2610-001')).outstandingSen).toBe(250_000);
    expect(sb.tables.acc_credit_note_allocations!.map((r) => [r.sales_invoice_id, r.amount_sen, r.applied_sen])).toEqual([['si-tan', 150_000, 150_000]]);

    const cancelled = await req(`/credit-notes/${note.id}/cancel`, 'POST');
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(sb.tables.acc_credit_note_allocations).toHaveLength(0);
    expect((await arRow(req, 'HC-SI-2610-001')).outstandingSen).toBe(400_000);
    expect(si('si-tan')).toMatchObject({ paid_sen: 0, status: 'PARTIALLY_PAID' });
    expect((await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [tick('si-tan', 1_000)] })).body.error).toBe('note_cancelled');
  });

  test('at post, an invoice paid meanwhile takes only what it owes — said, and the rest stays as credit on the customer', async () => {
    const { req, si } = harness();
    const note = await raise(req, CN({ allocations: [tick('si-tan', 30_000)] }));
    si('si-tan').paid_sen = 395_000;
    const posted = await req(`/credit-notes/${note.id}/post`, 'POST');
    expect(posted.status).toBe(200);
    expect(posted.body.applied).toEqual([{ kind: 'SI', id: 'si-tan', number: 'HC-SI-2610-001', appliedSen: 5_000 }]);
    expect(posted.body.notApplied).toBe('HC-SI-2610-001 owed only RM 50.00 — RM 250.00 stays as credit on the customer.');
  });

  test('a cancelled invoice gives its credit back to the note', async () => {
    const { req, sb } = harness();
    const note = await raise(req, CN({ allocations: [tick('si-tan', 30_000)] }));
    await req(`/credit-notes/${note.id}/post`, 'POST');
    await releaseSalesInvoiceKnockOffs(sb, { companyId: CO, siId: 'si-tan' });
    expect(sb.tables.acc_credit_note_allocations).toHaveLength(0);
    expect((await req(`/credit-notes/${note.id}/knock-off`)).body).toMatchObject({ takenSen: 0, leftSen: 30_000 });
    /* The Sales cancel calls it, beside the deposit invoices' release. */
    const src = readFileSync(resolve(__dirname, '../src/scm/routes/sales-invoices.ts'), 'utf8');
    expect(src).toMatch(/releaseDepositInvoicesBestEffort\([\s\S]{0,400}?releaseSalesInvoiceKnockOffs\(sb, \{ companyId: auditCompanyId \?\? null, siId: id \}\)/);
  });
});

describe('the refusals', () => {
  test('over the note, over what the invoice owes after its deposit and the other notes, another customer, another company', async () => {
    const { req } = harness();
    const a = await raise(req, CN({ lines: [{ amountSen: 300_000 }], allocations: [tick('si-tan', 300_000)] }));
    expect((await req(`/credit-notes/${a.id}/post`, 'POST')).status).toBe(200);
    const b = await raise(req, CN({ lines: [{ amountSen: 200_000 }] }));
    expect((await req(`/credit-notes/${b.id}/post`, 'POST')).status).toBe(200);
    const put = (targets: Row[]) => req(`/credit-notes/${b.id}/allocations`, 'PUT', { targets });
    expect((await put([tick('si-tan', 150_000)])).body).toMatchObject({ error: 'over_invoice', message: 'HC-SI-2610-001 only has RM 1,000.00 outstanding.' });
    expect((await put([tick('si-tan', 250_000)])).body.error).toBe('over_credit');
    expect((await put([tick('si-lee', 1_000)])).body.error).toBe('invoice_not_this_customer');
    expect((await put([tick('si-co2', 1_000)])).body.error).toBe('invoice_not_this_customer');
    expect((await put([tick('si-draft', 1_000)])).body.error).toBe('invoice_not_owing');
    expect((await put([{ kind: 'PI', id: 'si-tan', amountSen: 1_000 }])).body.error).toBe('bad_target');
    expect((await put([tick('si-tan', 100_000)])).status).toBe(200);

    /* A new note is held to the same, and only a credit note knocks anything off. */
    const over = await req('/credit-notes', 'POST', CN({ allocations: [tick('si-tan', 30_000)] }));
    expect(over.body).toMatchObject({ error: 'over_invoice', message: 'HC-SI-2610-001 only has RM 0.00 outstanding.' });
    const dn = await req('/credit-notes', 'POST', { ...CN(), kind: 'DN', allocations: [tick('si-tan', 1_000)] });
    expect([dn.status, dn.body.error]).toEqual([400, 'invoice_not_this_kind']);
  });

  test("a posted note's knock-off is the poster's", async () => {
    const { req, sb } = harness(['scm.payment_voucher.create']);
    const note = await raise(req, CN());
    expect((await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [tick('si-tan', 10_000)] })).status).toBe(200);
    sb.tables.acc_credit_notes!.find((n) => n.id === note.id)!.status = 'POSTED';
    const refused = await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [] });
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("knock off a customer's invoice");
  });
});

describe('a deposit paper knocks nothing off', () => {
  const closeOut = (sb: ReturnType<typeof harness>['sb'], over: Row = {}) => {
    sb.tables.acc_credit_notes!.push({
      id: 'cn-close', company_id: CO, note_number: 'HC-CN-2610-050', kind: 'CN', party_type: 'CUSTOMER', party_code: '300-C002', party_name: 'Tan Ah Kow',
      supplier_id: null, debtor_id: null, so_doc_no: 'HC-SO-2610-001', sales_invoice_id: 'si-tan', ap_invoice_id: null, purchase_invoice_id: null,
      source_doc_no: 'HC-DI-2610-001', note_date: '2026-10-05', total_sen: 100_000, reason: 'Deposit invoice HC-DI-2610-001 closed by final invoice HC-SI-2610-001',
      notes: null, status: 'POSTED', je_no: 'HC-JE-2610-0100', refund_pv_id: null, converted_payment_id: null, opening: false, created_at: '2026-10-05T00:00:00Z', ...over,
    });
    sb.tables.acc_deposit_invoices!.push({ id: 'di-1', company_id: CO, di_number: 'HC-DI-2610-001', so_doc_no: 'HC-SO-2610-001', amount_sen: 100_000, status: 'ISSUED', credit_note_id: over.refund_pv_id ? null : 'cn-close' });
  };

  test('the close-out: refused, listed on its invoice for what it is, and the invoice is not lowered twice', async () => {
    const { req, sb } = harness();
    closeOut(sb);
    const put = await req('/credit-notes/cn-close/allocations', 'PUT', { targets: [tick('si-tan', 10_000)] });
    expect([put.status, put.body.error]).toEqual([409, 'deposit_note']);
    expect(put.body.message).toBe("HC-CN-2610-050 closes deposit invoice HC-DI-2610-001 at the final invoice — the order's deposit lowers that invoice, so the note knocks nothing off.");
    const t = (await req('/credit-notes/cn-close/knock-off')).body;
    expect(t).toMatchObject({ rows: [], takenSen: 0, leftSen: 0 });
    expect(String(t.refusal)).toContain('closes deposit invoice HC-DI-2610-001');
    expect(((await req('/credit-notes?side=AR')).body.rows as Row[]).find((r) => r.id === 'cn-close')).toMatchObject({ depositPaper: 'closes', appliedSen: 0, unusedSen: 0 });
    const detail = (await req('/credit-notes/cn-close')).body;
    expect(detail).toMatchObject({ depositPaper: { kind: 'closes', di: 'HC-DI-2610-001' }, leftSen: 0, closedInvoice: { id: 'si-tan', number: 'HC-SI-2610-001', date: '2026-10-05', totalSen: 500_000 } });

    expect((await req('/ar-invoices/sales/si-tan/credit-notes')).body.creditNotes).toEqual([
      { id: 'cn-close', number: 'HC-CN-2610-050', date: '2026-10-05', what: 'Closes deposit invoice HC-DI-2610-001', amountSen: 100_000, closesDeposit: true },
    ]);
    /* The order's deposit lowers it once; the close-out does not lower it again. */
    expect(await arRow(req, 'HC-SI-2610-001')).toMatchObject({ depositAppliedSen: 100_000, creditNotesSen: 0, outstandingSen: 400_000 });
  });

  test("a refund's note: its money went back to the customer", async () => {
    const { req, sb } = harness();
    closeOut(sb, { refund_pv_id: 'pv-1', sales_invoice_id: null, reason: 'Refund HC-PV-2610-003 — part of deposit invoice HC-DI-2610-001' });
    const put = await req('/credit-notes/cn-close/allocations', 'PUT', { targets: [tick('si-tan', 10_000)] });
    expect([put.status, put.body.error]).toEqual([409, 'deposit_note']);
    expect(put.body.message).toBe('HC-CN-2610-050 takes back a deposit for a refund — that money went back to the customer, so it knocks nothing off.');
    expect(((await req('/credit-notes?side=AR')).body.rows as Row[]).find((r) => r.id === 'cn-close')).toMatchObject({ depositPaper: 'refund', unusedSen: 0 });
    expect((await req('/ar-invoices/sales/si-tan/credit-notes')).body.creditNotes).toEqual([]);
  });
});
