/* Credit and debit notes (owner 2026-09-05 / 2026-09-12; docs/bugs/0827).
   Pinned:
     • create mints {co}-CN-YYMM-NNN / DN / SCN and stays DRAFT; the customer
       comes from the sales order (the party code a payment on it carries),
       the invoice, or the typed name; a supplier note needs its supplier;
     • a line with no account lands on the kind's default — RETURN INWARDS
       for a customer note, PURCHASES RETURN for a supplier's;
     • post books CN: Dr lines / Cr AR (party); DN: Dr AR / Cr lines; SCN: Dr
       the supplier's AP control (405 for a 405-x supplier) / Cr lines —
       through the ONE gate, once (a second post echoes);
     • cancel writes the contra for a posted note, nothing for a draft; a
       posted note is not edited;
     • a control account on a line is refused by name; the permission gate
       answers at this end.
   Same fake-PostgREST harness as tests/apInvoices.test.ts. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';
import { customerPartyCode } from '../src/acc/payments';

const CO = 2;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
  acct('405-0000', 'OTHER CREDITORS', 'LIABILITY', { special_type: 'SCC' }),
  acct('500-0000', 'Sales', 'INCOME'),
  acct('500-0003', 'SALES OF SOFA', 'INCOME', { parent_code: '500-0000' }),
  acct('510-0000', 'RETURN INWARDS', 'INCOME'),
  acct('520-0000', 'DISCOUNT ALLOWED', 'INCOME'),
  acct('612-0000', 'PURCHASES RETURN', 'EXPENSE'),
  acct('900-A001', 'RENTAL', 'EXPENSE'),
];
const SUPPLIERS: Row[] = [
  { id: 'sup-h', company_id: CO, code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  { id: 'sup-f', company_id: CO, code: '400-F001', name: 'FOSHAN CHAIRS' },
];
const ORDERS: Row[] = [
  { doc_no: '2990-SO-2607-019', company_id: CO, debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding', status: 'DELIVERED' },
];
const INVOICES: Row[] = [
  { id: 'si-1', company_id: CO, invoice_number: '2990-SI-2609-001', so_doc_no: '2990-SO-2607-019', debtor_code: 'D-LARDING', debtor_name: 'Larding Chen' },
];

function harness(perms: readonly string[] = PV_KEYS) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    suppliers: SUPPLIERS.map((r) => ({ ...r })),
    mfg_sales_orders: ORDERS.map((r) => ({ ...r })),
    sales_invoices: INVOICES.map((r) => ({ ...r })),
    acc_account_roles: [],
    acc_credit_notes: [], acc_credit_note_lines: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/credit-notes', creditNotes);
  return { app, sb };
}
const json = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const CN = { kind: 'CN', soDocNo: '2990-SO-2607-019', noteDate: '2026-09-01', reason: 'Sofa leg scratched', sourceDocNo: 'DR-2609-001', lines: [{ description: 'Scratched leg — goodwill', amountSen: 15_000 }] };

const linesOf = (sb: ReturnType<typeof harness>['sb'], jeNo: string) => {
  const je = (sb.tables.journal_entries as Row[]).find((j) => j.je_no === jeNo)!;
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id)
    .map((l) => ({ code: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), party: l.party_code ?? null }));
};

describe('raising a note', () => {
  test('a customer credit note from the sales order: {co}-CN-YYMM-NNN, the order\'s customer, DRAFT, the default line account', async () => {
    const { app, sb } = harness();
    const res = await json(app, '/credit-notes', 'POST', CN);
    expect(res.status).toBe(201);
    const b = await res.json() as { note: Row };
    expect(b.note.note_number).toBe('2990-CN-2609-001');
    expect(b.note).toMatchObject({
      kind: 'CN', status: 'DRAFT', total_sen: 15_000, party_type: 'CUSTOMER', party_name: 'Larding Chen',
      party_code: customerPartyCode(null, 'cust-larding'), so_doc_no: '2990-SO-2607-019', source_doc_no: 'DR-2609-001', je_no: null,
    });
    expect(sb.tables.acc_credit_note_lines).toEqual([expect.objectContaining({ line_no: 1, account_code: '510-0000', amount_sen: 15_000 })]);
    expect(sb.tables.journal_entries).toHaveLength(0);
    /* The second note of the month takes the next number. */
    const again = await json(app, '/credit-notes', 'POST', CN);
    expect((await again.json() as { note: Row }).note.note_number).toBe('2990-CN-2609-002');
  });

  test('the customer can come from the invoice, or be the name typed; a note with nobody is refused', async () => {
    const { app } = harness();
    const fromSi = await json(app, '/credit-notes', 'POST', { ...CN, soDocNo: undefined, salesInvoiceId: 'si-1' });
    expect(fromSi.status).toBe(201);
    expect((await fromSi.json() as { note: Row }).note).toMatchObject({ party_code: 'D-LARDING', party_name: 'Larding Chen', sales_invoice_id: 'si-1', so_doc_no: '2990-SO-2607-019' });
    const typed = await json(app, '/credit-notes', 'POST', { ...CN, soDocNo: undefined, partyName: 'Walk-in Ah Meng' });
    expect(typed.status).toBe(201);
    expect((await typed.json() as { note: Row }).note).toMatchObject({ party_code: null, party_name: 'Walk-in Ah Meng' });
    const nobody = await json(app, '/credit-notes', 'POST', { ...CN, soDocNo: undefined });
    expect(nobody.status).toBe(400);
    expect((await nobody.json() as { error: string }).error).toBe('party_required');
    const unknownSo = await json(app, '/credit-notes', 'POST', { ...CN, soDocNo: '2990-SO-0000-000' });
    expect(unknownSo.status).toBe(400);
  });

  test('a supplier credit note needs its supplier and lands on PURCHASES RETURN by default', async () => {
    const { app, sb } = harness();
    const res = await json(app, '/credit-notes', 'POST', { kind: 'SCN', supplierId: 'sup-h', noteDate: '2026-09-03', lines: [{ amountSen: 50_000 }] });
    expect(res.status).toBe(201);
    expect((await res.json() as { note: Row }).note).toMatchObject({ note_number: '2990-SCN-2609-001', party_type: 'SUPPLIER', party_code: '405-H001', supplier_id: 'sup-h' });
    expect(sb.tables.acc_credit_note_lines[0]).toMatchObject({ account_code: '612-0000' });
    const noSupplier = await json(app, '/credit-notes', 'POST', { kind: 'SCN', lines: [{ amountSen: 50_000 }] });
    expect(noSupplier.status).toBe(400);
    expect((await noSupplier.json() as { error: string }).error).toBe('supplier_required');
  });

  test('a control account on a line, a bad kind and a missing permission are refused by name', async () => {
    const { app } = harness();
    const control = await json(app, '/credit-notes', 'POST', { ...CN, lines: [{ accountCode: '300-0000', amountSen: 100 }] });
    expect(control.status).toBeGreaterThanOrEqual(400);
    expect((await control.json() as { error: string }).error).toBe('control_account_locked');
    const kind = await json(app, '/credit-notes', 'POST', { ...CN, kind: 'XX' });
    expect(kind.status).toBe(400);
    const { app: noPerm } = harness(['scm.access']);
    expect((await json(noPerm, '/credit-notes', 'POST', CN)).status).toBe(403);
  });
});

describe('posting and cancelling', () => {
  const raise = async (app: Hono, body: unknown) => (await (await json(app, '/credit-notes', 'POST', body)).json() as { note: Row }).note;

  test('a customer credit note posts Dr the line / Cr AR with the customer on it, once', async () => {
    const { app, sb } = harness();
    const note = await raise(app, CN);
    const res = await json(app, `/credit-notes/${note.id}/post`, 'POST');
    expect(res.status).toBe(200);
    const b = await res.json() as { jeNo: string; status: string };
    expect(b.status).toBe('posted');
    expect(linesOf(sb, b.jeNo)).toEqual([
      { code: '510-0000', dr: 15_000, cr: 0, party: null },
      { code: '300-0000', dr: 0, cr: 15_000, party: customerPartyCode(null, 'cust-larding') },
    ]);
    expect((sb.tables.acc_credit_notes as Row[])[0]).toMatchObject({ status: 'POSTED', je_no: b.jeNo });
    const again = await (await json(app, `/credit-notes/${note.id}/post`, 'POST')).json() as { status: string; jeNo: string };
    expect(again).toMatchObject({ status: 'already_posted', jeNo: b.jeNo });
    expect(sb.tables.journal_entries).toHaveLength(1);
  });

  test('a debit note posts Dr AR / Cr the line; a supplier credit note Dr the 405 control / Cr the line', async () => {
    const { app, sb } = harness();
    const dn = await raise(app, { kind: 'DN', soDocNo: '2990-SO-2607-019', noteDate: '2026-09-02', lines: [{ accountCode: '520-0000', amountSen: 2_000, description: 'Discount withdrawn' }] });
    const dnPost = await (await json(app, `/credit-notes/${dn.id}/post`, 'POST')).json() as { jeNo: string };
    expect(linesOf(sb, dnPost.jeNo)).toEqual([
      { code: '300-0000', dr: 2_000, cr: 0, party: customerPartyCode(null, 'cust-larding') },
      { code: '520-0000', dr: 0, cr: 2_000, party: null },
    ]);
    const scn = await raise(app, { kind: 'SCN', supplierId: 'sup-h', noteDate: '2026-09-03', lines: [{ amountSen: 50_000 }] });
    const scnPost = await (await json(app, `/credit-notes/${scn.id}/post`, 'POST')).json() as { jeNo: string };
    expect(linesOf(sb, scnPost.jeNo)).toEqual([
      { code: '405-0000', dr: 50_000, cr: 0, party: '405-H001' },
      { code: '612-0000', dr: 0, cr: 50_000, party: null },
    ]);
    const trade = await raise(app, { kind: 'SCN', supplierId: 'sup-f', noteDate: '2026-09-03', lines: [{ amountSen: 7_000 }] });
    const tradePost = await (await json(app, `/credit-notes/${trade.id}/post`, 'POST')).json() as { jeNo: string };
    expect(linesOf(sb, tradePost.jeNo)[0]).toEqual({ code: '400-0000', dr: 7_000, cr: 0, party: '400-F001' });
  });

  test('cancel writes the contra for a posted note and nothing for a draft; a posted note is not edited', async () => {
    const { app, sb } = harness();
    const posted = await raise(app, CN);
    await json(app, `/credit-notes/${posted.id}/post`, 'POST');
    const edit = await json(app, `/credit-notes/${posted.id}`, 'PATCH', { reason: 'changed my mind' });
    expect(edit.status).toBe(409);
    expect((await edit.json() as { error: string }).error).toBe('not_editable');
    expect((await json(app, `/credit-notes/${posted.id}/cancel`, 'POST')).status).toBe(200);
    expect(sb.tables.journal_entries).toHaveLength(2);
    const original = (sb.tables.journal_entries as Row[]).find((j) => j.source_type === 'CN')!;
    expect(original.reversed).toBe(true);
    expect((sb.tables.journal_entries as Row[]).some((j) => j.source_type === 'CN_REVERSAL')).toBe(true);
    expect((sb.tables.acc_credit_notes as Row[]).find((n) => n.id === posted.id)).toMatchObject({ status: 'CANCELLED' });

    const draft = await raise(app, CN);
    const edited = await json(app, `/credit-notes/${draft.id}`, 'PATCH', { reason: 'Two legs', lines: [{ amountSen: 30_000 }] });
    expect(edited.status).toBe(200);
    expect((await edited.json() as { note: Row }).note).toMatchObject({ total_sen: 30_000, reason: 'Two legs' });
    expect((await json(app, `/credit-notes/${draft.id}/cancel`, 'POST')).status).toBe(200);
    expect(sb.tables.journal_entries).toHaveLength(2);
    const detail = await (await app.request(`/credit-notes/${draft.id}`)).json() as { note: Row; lines: Row[] };
    expect(detail.note.status).toBe('CANCELLED');
    expect(detail.lines).toHaveLength(1);
  });

  test('the list filters by kind and status', async () => {
    const { app } = harness();
    await raise(app, CN);
    const scn = await raise(app, { kind: 'SCN', supplierId: 'sup-h', lines: [{ amountSen: 1 }] });
    await json(app, `/credit-notes/${scn.id}/post`, 'POST');
    const all = await (await app.request('/credit-notes')).json() as { rows: Row[] };
    expect(all.rows).toHaveLength(2);
    const scns = await (await app.request('/credit-notes?kind=scn')).json() as { rows: Row[] };
    expect(scns.rows.map((r) => r.kind)).toEqual(['SCN']);
    const drafts = await (await app.request('/credit-notes?status=draft')).json() as { rows: Row[] };
    expect(drafts.rows.map((r) => r.kind)).toEqual(['CN']);
  });
});
