/* A supplier credit note's credit coming off the supplier's invoices (owner
   2026-10-01, Supplier CN part 2: 有写发票的 CN 直接扣那张发票的欠款；没写的先挂在
   Diglant 名下，再选要扣哪几张发票；付款时只付剩下的). Pinned:
     • a note naming its invoice takes the credit off it the moment it posts —
       as much as the invoice still owes, the rest staying as the supplier's
       credit — and an AP Payment then owes only what is left;
     • a note naming none keeps its credit; Finance takes it off the supplier's
       invoices it picks, within what each owes and what the note has left;
     • a remove gives one application back; a cancel gives them all back before
       its contra — the invoices owe again exactly what was applied;
     • the refusals: a draft, a customer note, another supplier's invoice, more
       than the invoice owes or the note has left, and the key. */

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

function harness(perms: readonly string[] = KEYS, pis: Row[] = []) {
  const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
    company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
  });
  const tables: Record<string, Row[]> = {
    accounts: [
      acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
      acct('591-0000', 'SPONSORSHIP', 'INCOME'),
      acct('610-0001', 'DISCOUNT RECEIVED', 'EXPENSE'),
      acct('612-0000', 'PURCHASES RETURN', 'EXPENSE'),
    ],
    suppliers: [
      { id: 'sup-d', company_id: CO, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', status: 'ACTIVE' },
      { id: 'sup-g', company_id: CO, code: '400-G005', name: 'GUANGDONG DIGLANT FURNITURE INDUSTRIAL CO.LTD', status: 'ACTIVE' },
    ],
    purchase_invoices: pis.length > 0 ? pis : [
      PI('pi-17', 'HC-PI-2610-017', 260_000), PI('pi-18', 'HC-PI-2610-018', 130_000), PI('pi-19', 'HC-PI-2610-019', 170_600),
      PI('pi-g', 'HC-PI-2610-099', 50_000, { supplier_id: 'sup-g', supplier_invoice_ref: 'G-1' }),
      PI('pi-draft', 'HC-PI-2610-050', 9_000, { status: 'DRAFT' }),
    ],
    ap_invoices: [],
    acc_account_roles: [],
    acc_credit_notes: [], acc_credit_note_lines: [], acc_credit_note_allocations: [], acc_credit_note_files: [],
    journal_entries: [], journal_entry_lines: [],
  };
  const sb = fakeSb(tables, {}, [], ['journal_entry_lines']);
  /* The settle functions as production has them (row lock, clamp at write time) —
     the same arithmetic the code shares with the AP Payment. */
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
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const pi = (id: string) => (sb as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: Row }> } } } })
    .from('purchase_invoices').select('paid_sen, status').eq('id', id).maybeSingle().then((r) => r.data);
  return { req, pi };
}

const SCN = (over: Row = {}) => ({ kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-21', lines: [{ description: "Sales Rebate - Aug'26", accountCode: '591-0000', amountSen: 2_862_237 }], ...over });
const raise = async (req: ReturnType<typeof harness>['req'], body: Row) => {
  const res = await req('/credit-notes', 'POST', body);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json() as { note: Row }).note.id as string;
};
type Detail = { note: Row; allocations: Row[]; appliedSen: number; leftSen: number };

describe('a note naming its invoice', () => {
  test('takes the credit off it the moment it posts; the detail shows it; a cancel gives it back', async () => {
    const { req, pi } = harness();
    const id = await raise(req, SCN({ purchaseInvoiceId: 'pi-17', sourceDocNo: 'DGPSC26000263', lines: [{ description: 'Equinox K display', accountCode: '610-0001', amountSen: 65_000 }] }));
    const posted = await req(`/credit-notes/${id}/post`, 'POST');
    expect(posted.status, await posted.clone().text()).toBe(200);
    expect((await posted.json() as Row).applied).toEqual([{ kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017', appliedSen: 65_000 }]);
    expect(await pi('pi-17')).toMatchObject({ paid_sen: 65_000, status: 'PARTIALLY_PAID' });

    const d = await (await req(`/credit-notes/${id}`, 'GET')).json() as Detail;
    expect(d.allocations.map((a) => [a.number, a.appliedSen])).toEqual([['HC-PI-2610-017', 65_000]]);
    expect([d.appliedSen, d.leftSen]).toEqual([65_000, 0]);

    expect((await req(`/credit-notes/${id}/cancel`, 'POST')).status).toBe(200);
    expect(await pi('pi-17')).toMatchObject({ paid_sen: 0, status: 'POSTED' });
    const after = await (await req(`/credit-notes/${id}`, 'GET')).json() as Detail;
    expect(after.allocations).toEqual([]);
  });

  test('an invoice owing less than the note: as much as it owes comes off, the rest stays as the supplier\'s credit', async () => {
    const { req, pi } = harness(KEYS, [PI('pi-17', 'HC-PI-2610-017', 260_000, { paid_sen: 250_000, status: 'PARTIALLY_PAID' })]);
    const id = await raise(req, SCN({ purchaseInvoiceId: 'pi-17', lines: [{ accountCode: '610-0001', amountSen: 65_000 }] }));
    const posted = await (await req(`/credit-notes/${id}/post`, 'POST')).json() as Row;
    expect(posted.applied).toEqual([{ kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017', appliedSen: 10_000 }]);
    expect(await pi('pi-17')).toMatchObject({ paid_sen: 260_000, status: 'PAID' });
    const d = await (await req(`/credit-notes/${id}`, 'GET')).json() as Detail;
    expect(d.leftSen).toBe(55_000);
  });
});

describe('a note naming no invoice', () => {
  test('keeps its credit; Finance takes it off the invoices it picks; a remove gives one back', async () => {
    const { req, pi } = harness();
    const id = await raise(req, SCN());
    const posted = await (await req(`/credit-notes/${id}/post`, 'POST')).json() as Row;
    expect(posted.applied).toBeUndefined();
    const open = await (await req(`/credit-notes/${id}/open-invoices`, 'GET')).json() as { invoices: Row[] };
    expect(open.invoices.map((i) => [i.number, i.outstandingSen])).toEqual([['HC-PI-2610-017', 260_000], ['HC-PI-2610-018', 130_000], ['HC-PI-2610-019', 170_600]]);

    const res = await req(`/credit-notes/${id}/apply`, 'POST', { targets: [{ kind: 'PI', id: 'pi-18', amountSen: 130_000 }, { kind: 'PI', id: 'pi-19', amountSen: 170_600 }] });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await pi('pi-18')).toMatchObject({ paid_sen: 130_000, status: 'PAID' });
    expect(await pi('pi-19')).toMatchObject({ paid_sen: 170_600, status: 'PAID' });
    const d = await (await req(`/credit-notes/${id}`, 'GET')).json() as Detail;
    expect(d.leftSen).toBe(2_862_237 - 300_600);

    const allocationId = d.allocations.find((a) => a.number === 'HC-PI-2610-018')!.id as string;
    expect((await req(`/credit-notes/${id}/allocations/${allocationId}/remove`, 'POST')).status).toBe(200);
    expect(await pi('pi-18')).toMatchObject({ paid_sen: 0, status: 'POSTED' });
    const back = await (await req(`/credit-notes/${id}`, 'GET')).json() as Detail;
    expect(back.leftSen).toBe(2_862_237 - 170_600);
  });

  test('refusals: more than the invoice owes, more than is left, another supplier\'s, an invoice owing nothing, a draft note, a customer note, the key', async () => {
    const { req } = harness();
    const small = await raise(req, SCN({ lines: [{ accountCode: '591-0000', amountSen: 100_000 }] }));
    await req(`/credit-notes/${small}/post`, 'POST');
    const apply = (id: string, targets: Row[]) => req(`/credit-notes/${id}/apply`, 'POST', { targets });
    const err = async (r: Promise<Response>) => { const res = await r; return [res.status, (await res.json() as Row).error]; };
    expect(await err(apply(small, [{ kind: 'PI', id: 'pi-18', amountSen: 130_001 }]))).toEqual([409, 'over_credit']);
    expect(await err(apply(small, [{ kind: 'PI', id: 'pi-19', amountSen: 100_000 }, { kind: 'PI', id: 'pi-18', amountSen: 1 }]))).toEqual([409, 'over_credit']);
    expect(await err(apply(small, [{ kind: 'PI', id: 'pi-g', amountSen: 100 }]))).toEqual([400, 'invoice_not_this_supplier']);
    expect(await err(apply(small, [{ kind: 'PI', id: 'pi-draft', amountSen: 100 }]))).toEqual([409, 'invoice_not_owing']);

    const big = await raise(req, SCN());
    await req(`/credit-notes/${big}/post`, 'POST');
    expect(await err(apply(big, [{ kind: 'PI', id: 'pi-18', amountSen: 130_001 }]))).toEqual([409, 'over_invoice']);

    const draft = await raise(req, SCN());
    expect(await err(apply(draft, [{ kind: 'PI', id: 'pi-18', amountSen: 100 }]))).toEqual([409, 'note_not_posted']);

    const cn = await raise(req, { kind: 'CN', partyName: 'Walk-in', lines: [{ amountSen: 100 }] });
    await req(`/credit-notes/${cn}/post`, 'POST');
    expect(await err(apply(cn, [{ kind: 'PI', id: 'pi-18', amountSen: 100 }]))).toEqual([400, 'not_a_supplier_note']);

    const { req: noKey } = harness(['scm.payment_voucher.create']);
    expect((await noKey(`/credit-notes/${big}/apply`, 'POST', { targets: [] })).status).toBe(403);
  });
});
