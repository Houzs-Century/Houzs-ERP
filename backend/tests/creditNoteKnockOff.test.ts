/* A supplier credit note knocks off the supplier's invoices the way an AP Payment
   does (owner 2026-10-02: CN 的方式应该是类似 ap payment 这样 knock off；扣错了就我
   untick 会 knock off 的 invoice 就行了). Pinned:
     • a new note's table is the supplier's invoices still owing;
     • the ticks ride a draft as its plan — nothing moves — and the post carries
       them out;
     • on a posted note the knock-off is set whole: an untick gives the invoice
       back, a tick takes another, a lower figure gives part back — one row per
       invoice, applied_sen what the settle really moved; an invoice the note
       paid in full stays on its table;
     • a draft's edit replaces the plan, and a new total below it is refused;
     • at post, an invoice paid meanwhile takes only what it owes, one
       cancelled meanwhile takes none — said, and the post stands;
     • the refusals: more than the note, more than an invoice owes, another
       supplier's invoice, an invoice not posted, a cancelled note, a customer
       note, and the keys (a posted note's knock-off is the poster's).
   Same harness as tests/creditNoteApply.test.ts — the settle functions emulated
   as production has them. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';
import { computePiSettlement } from '../src/scm/lib/pi-settlement';

const CO = 1;
const KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

const PI = (id: string, number: string, total: number, over: Row = {}): Row => ({
  id, company_id: CO, invoice_number: number, supplier_id: 'sup-d', supplier_invoice_ref: 'DGSIZ26001811', invoice_date: '2026-09-07', total_sen: total, paid_sen: 0, status: 'POSTED', ...over,
});

function harness(perms: readonly string[] = KEYS) {
  const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
    company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
  });
  const tables: Record<string, Row[]> = {
    accounts: [
      acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
      acct('510-0000', 'RETURN INWARDS', 'INCOME'),
      acct('591-0000', 'SPONSORSHIP', 'INCOME'),
      acct('610-0001', 'DISCOUNT RECEIVED', 'EXPENSE'),
      acct('612-0000', 'PURCHASES RETURN', 'EXPENSE'),
    ],
    suppliers: [
      { id: 'sup-d', company_id: CO, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', status: 'ACTIVE' },
      { id: 'sup-g', company_id: CO, code: '400-G005', name: 'GUANGDONG DIGLANT FURNITURE INDUSTRIAL CO.LTD', status: 'ACTIVE' },
    ],
    purchase_invoices: [
      PI('pi-17', 'HC-PI-2610-017', 260_000), PI('pi-18', 'HC-PI-2610-018', 130_000, { invoice_date: '2026-09-08' }), PI('pi-19', 'HC-PI-2610-019', 170_600, { invoice_date: '2026-09-09' }),
      PI('pi-g', 'HC-PI-2610-099', 50_000, { supplier_id: 'sup-g', supplier_invoice_ref: 'G-1' }),
      PI('pi-draft', 'HC-PI-2610-050', 9_000, { status: 'DRAFT' }),
    ],
    ap_invoices: [],
    acc_account_roles: [],
    acc_credit_notes: [], acc_credit_note_lines: [], acc_credit_note_allocations: [], acc_credit_note_files: [],
    journal_entries: [], journal_entry_lines: [],
  };
  const sb = fakeSb(tables, {}, [], ['journal_entry_lines']);
  const settleOn = (table: string, idArg: string) => (args: Record<string, unknown>) => {
    const row = (sb.tables[table] ?? []).find((r) => r.id === args[idArg]);
    if (!row) return [{ applied_sen: 0, reason: 'not_found' }];
    const calc = computePiSettlement({ paidSen: Number(row.paid_sen ?? 0), totalSen: Number(row.total_sen ?? 0), status: String(row.status), deltaSen: Number(args.p_delta ?? 0) });
    if (!calc.skipped) { row.paid_sen = calc.newPaidSen; row.status = calc.newStatus; }
    return [{ applied_sen: calc.skipped ? 0 : calc.appliedSen, new_paid_sen: row.paid_sen, new_status: row.status }];
  };
  sb.rpcHandlers.settle_pi_paid_sen = settleOn('purchase_invoices', 'p_pi_id');
  sb.rpcHandlers.settle_api_paid_sen = settleOn('ap_invoices', 'p_id');
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
  const req = async (path: string, method: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Row };
  };
  const inv = (id: string) => {
    const r = (sb.tables.purchase_invoices ?? []).find((x) => x.id === id)!;
    return { paid: Number(r.paid_sen), status: String(r.status) };
  };
  return { req, inv, sb };
}

/* RM 3,000.00 of sales rebate from Diglant. */
const SCN = (over: Row = {}) => ({ kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-21', lines: [{ description: "Sales Rebate - Aug'26", accountCode: '591-0000', amountSen: 300_000 }], ...over });
const tick = (id: string, amountSen: number) => ({ kind: 'PI', id, amountSen });
const raise = async (req: ReturnType<typeof harness>['req'], body: Row) => {
  const res = await req('/credit-notes', 'POST', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String((res.body.note as Row).id);
};
const table = (body: Row) => (body.rows as Row[]).map((r) => [r.number, r.owedSen, r.noteSen]);

describe('the ticks on a new note — a plan the post carries out', () => {
  test('the table is the supplier\'s invoices still owing; the draft moves nothing; the post knocks them off', async () => {
    const { req, inv } = harness();
    const fresh = await req('/credit-notes/knock-off?supplierId=sup-d', 'GET');
    expect(fresh.status).toBe(200);
    expect(table(fresh.body)).toEqual([['HC-PI-2610-017', 260_000, 0], ['HC-PI-2610-018', 130_000, 0], ['HC-PI-2610-019', 170_600, 0]]);

    const id = await raise(req, SCN({ allocations: [tick('pi-17', 200_000), tick('pi-18', 100_000)] }));
    expect([inv('pi-17').paid, inv('pi-18').paid]).toEqual([0, 0]);
    const draft = await req(`/credit-notes/${id}/knock-off`, 'GET');
    expect(draft.body).toMatchObject({ totalSen: 300_000, takenSen: 300_000, leftSen: 0, posted: false });
    expect(table(draft.body)).toEqual([['HC-PI-2610-017', 260_000, 200_000], ['HC-PI-2610-018', 130_000, 100_000], ['HC-PI-2610-019', 170_600, 0]]);

    const posted = await req(`/credit-notes/${id}/post`, 'POST');
    expect(posted.status).toBe(200);
    expect(posted.body.applied).toEqual([
      { kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017', appliedSen: 200_000 },
      { kind: 'PI', id: 'pi-18', number: 'HC-PI-2610-018', appliedSen: 100_000 },
    ]);
    expect(posted.body.notApplied).toBeUndefined();
    expect(inv('pi-17')).toEqual({ paid: 200_000, status: 'PARTIALLY_PAID' });
    expect(inv('pi-18')).toEqual({ paid: 100_000, status: 'PARTIALLY_PAID' });
    /* Posted: what each owed before this note, and what the note took. */
    const after = await req(`/credit-notes/${id}/knock-off`, 'GET');
    expect(after.body).toMatchObject({ takenSen: 300_000, leftSen: 0, posted: true });
    expect(table(after.body)).toEqual([['HC-PI-2610-017', 260_000, 200_000], ['HC-PI-2610-018', 130_000, 100_000], ['HC-PI-2610-019', 170_600, 0]]);
  });

  test('a draft\'s edit replaces the plan; a new total below what is planned is refused', async () => {
    const { req } = harness();
    const id = await raise(req, SCN({ allocations: [tick('pi-17', 200_000)] }));
    const lower = { lines: [{ description: 'Rebate', accountCode: '591-0000', amountSen: 150_000 }] };
    const refused = await req(`/credit-notes/${id}`, 'PATCH', lower);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'over_credit', message: "The knock-off planned (RM 2,000.00) is more than the note's new total (RM 1,500.00) — untick some first." });
    const ok = await req(`/credit-notes/${id}`, 'PATCH', { ...lower, allocations: [tick('pi-18', 100_000)] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(table((await req(`/credit-notes/${id}/knock-off`, 'GET')).body)).toEqual([['HC-PI-2610-017', 260_000, 0], ['HC-PI-2610-018', 130_000, 100_000], ['HC-PI-2610-019', 170_600, 0]]);
  });

  test('at post, an invoice paid meanwhile takes what it owes, one cancelled meanwhile takes none — said; the post stands', async () => {
    const { req, inv, sb } = harness();
    const id = await raise(req, SCN({ allocations: [tick('pi-17', 100_000), tick('pi-18', 130_000)] }));
    const pi17 = sb.tables.purchase_invoices!.find((r) => r.id === 'pi-17')!;
    const pi18 = sb.tables.purchase_invoices!.find((r) => r.id === 'pi-18')!;
    pi17.status = 'CANCELLED';
    pi18.paid_sen = 100_000; pi18.status = 'PARTIALLY_PAID';
    const posted = await req(`/credit-notes/${id}/post`, 'POST');
    expect(posted.status).toBe(200);
    expect(posted.body.applied).toEqual([{ kind: 'PI', id: 'pi-18', number: 'HC-PI-2610-018', appliedSen: 30_000 }]);
    expect(posted.body.notApplied).toBe('HC-PI-2610-017 owes nothing now — its RM 1,000.00 stays with the supplier. HC-PI-2610-018 owed only RM 300.00 — RM 1,000.00 stays with the supplier.');
    expect(inv('pi-18')).toEqual({ paid: 130_000, status: 'PAID' });
    expect(sb.tables.acc_credit_note_allocations!.map((r) => [r.purchase_invoice_id, r.applied_sen])).toEqual([['pi-18', 30_000]]);
  });
});

describe('a posted note\'s knock-off, set whole', () => {
  test('untick gives an invoice back, a tick takes another, a lower figure gives part back; one paid in full stays on the table', async () => {
    const { req, inv, sb } = harness();
    const id = await raise(req, SCN({ allocations: [tick('pi-17', 200_000)] }));
    expect((await req(`/credit-notes/${id}/post`, 'POST')).status).toBe(200);
    expect(inv('pi-17')).toEqual({ paid: 200_000, status: 'PARTIALLY_PAID' });

    /* 扣错了: untick PI-017, tick PI-018 in full and RM 1,000 of PI-019. */
    const set = await req(`/credit-notes/${id}/allocations`, 'PUT', { targets: [tick('pi-18', 130_000), tick('pi-19', 100_000)] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ ok: true, short: [] });
    expect(inv('pi-17')).toEqual({ paid: 0, status: 'POSTED' });
    expect(inv('pi-18')).toEqual({ paid: 130_000, status: 'PAID' });
    expect(inv('pi-19')).toEqual({ paid: 100_000, status: 'PARTIALLY_PAID' });
    const t = await req(`/credit-notes/${id}/knock-off`, 'GET');
    expect(t.body).toMatchObject({ takenSen: 230_000, leftSen: 70_000 });
    expect(table(t.body)).toEqual([['HC-PI-2610-017', 260_000, 0], ['HC-PI-2610-018', 130_000, 130_000], ['HC-PI-2610-019', 170_600, 100_000]]);

    /* PI-018 down to RM 300, PI-019 unticked. */
    expect((await req(`/credit-notes/${id}/allocations`, 'PUT', { targets: [tick('pi-18', 30_000)] })).status).toBe(200);
    expect(inv('pi-18')).toEqual({ paid: 30_000, status: 'PARTIALLY_PAID' });
    expect(inv('pi-19')).toEqual({ paid: 0, status: 'POSTED' });
    expect(sb.tables.acc_credit_note_allocations!.map((r) => [r.purchase_invoice_id, r.amount_sen, r.applied_sen])).toEqual([['pi-18', 30_000, 30_000]]);

    /* Nothing ticked: the whole credit is the supplier's again. */
    expect((await req(`/credit-notes/${id}/allocations`, 'PUT', { targets: [] })).status).toBe(200);
    expect(inv('pi-18')).toEqual({ paid: 0, status: 'POSTED' });
    expect((await req(`/credit-notes/${id}/knock-off`, 'GET')).body).toMatchObject({ takenSen: 0, leftSen: 300_000 });
  });

  test('the refusals — and a posted note\'s knock-off is the poster\'s', async () => {
    const { req } = harness();
    const id = await raise(req, SCN());
    expect((await req(`/credit-notes/${id}/post`, 'POST')).status).toBe(200);
    const put = (targets: Row[]) => req(`/credit-notes/${id}/allocations`, 'PUT', { targets });
    const no = String(((await req(`/credit-notes/${id}`, 'GET')).body.note as Row).note_number);
    expect((await put([tick('pi-17', 200_000), tick('pi-19', 150_000)])).body).toMatchObject({ error: 'over_credit', message: `${no} is RM 3,000.00 — knocking off RM 3,500.00 is more.` });
    expect((await put([tick('pi-18', 140_000)])).body).toMatchObject({ error: 'over_invoice', message: 'HC-PI-2610-018 owes RM 1,300.00 — RM 1,400.00 is more.' });
    expect((await put([tick('pi-g', 10_000)])).body.error).toBe('invoice_not_this_supplier');
    expect((await put([tick('pi-draft', 1_000)])).body.error).toBe('invoice_not_owing');
    expect((await put([tick('pi-17', 0)])).body.error).toBe('bad_amount');
    expect((await put([tick('pi-17', 1_000), tick('pi-17', 2_000)])).body.error).toBe('bad_target');

    /* The editor may plan a draft's ticks; only the poster moves a posted note's. */
    const editor = harness(['scm.payment_voucher.create']);
    const draftId = await raise(editor.req, SCN());
    expect((await editor.req(`/credit-notes/${draftId}/allocations`, 'PUT', { targets: [tick('pi-17', 10_000)] })).status).toBe(200);
    editor.sb.tables.acc_credit_notes!.find((n) => n.id === draftId)!.status = 'POSTED';
    expect((await editor.req(`/credit-notes/${draftId}/allocations`, 'PUT', { targets: [] })).status).toBe(403);

    expect((await req(`/credit-notes/${id}/cancel`, 'POST')).status).toBe(200);
    expect((await put([tick('pi-17', 1_000)])).body.error).toBe('note_cancelled');
    const customer = await req('/credit-notes', 'POST', { kind: 'CN', partyName: 'Larding Chen', noteDate: '2026-09-21', lines: [{ accountCode: '510-0000', amountSen: 10_000 }], allocations: [tick('pi-17', 10_000)] });
    expect(customer.body.error).toBe('invoice_not_this_kind');
  });
});
