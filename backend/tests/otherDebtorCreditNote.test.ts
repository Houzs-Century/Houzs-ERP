/* A credit note TO an other debtor (owner 2026-10-28: Customer & Other Debtor CN
   / DN beside Supplier & Other Creditor CN / DN — 「可以」; AutoCount's CN-2609-025
   gives EASTERN DECORATOR a RM 2,000 discount). Pinned:
     • kind OCN takes a debtor of the Other Debtors registry, and every line names
       its account — there is no default;
     • posted: Dr each line / Cr the other-debtor control for the debtor, named as
       a debtor bill names it (ODEBTOR, no code, the registry name);
     • its ticks ride the draft as a plan and the post knocks the debtor's bills
       off through scm.settle_odb_received_sen — received_sen up, PAID when full;
       untick and cancel give back exactly what was applied;
     • the refusals: no debtor, a line with no account, another debtor's bill,
       a supplier's invoice as a target;
     • the two Finance pages: side=AR lists CN / DN / OCN, side=AP the SCN. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';

const CO = 1;
const KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

function harness() {
  const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
    company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
  });
  const bill = (id: string, number: string, debtorId: string, total: number, over: Row = {}): Row => ({
    id, company_id: CO, bill_number: number, debtor_id: debtorId, bill_date: '2026-08-31', total_sen: total, received_sen: 0, status: 'POSTED', ...over,
  });
  const tables: Record<string, Row[]> = {
    accounts: [
      acct('305-0000', 'OTHER DEBTOR', 'ASSET'),
      acct('520-0000', 'DISCOUNT ALLOWED', 'INCOME'),
      acct('510-0000', 'RETURN INWARDS', 'INCOME'),
      acct('612-0000', 'PURCHASES RETURN', 'EXPENSE'),
    ],
    acc_debtors: [
      { id: 'deb-e', company_id: CO, name: 'EASTERN DECORATOR SDN. BHD.', is_active: true },
      { id: 'deb-t', company_id: CO, name: 'TANGUANYU ENTERPRISE', is_active: true },
    ],
    acc_debtor_bills: [
      bill('odb-e', 'HC-ODB-2608-005', 'deb-e', 6_920_000),
      bill('odb-t', 'HC-ODB-2608-009', 'deb-t', 30_548_314),
    ],
    suppliers: [{ id: 'sup-d', company_id: CO, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', status: 'ACTIVE' }],
    purchase_invoices: [{ id: 'pi-1', company_id: CO, invoice_number: 'HC-PI-2610-017', supplier_id: 'sup-d', total_sen: 260_000, paid_sen: 0, status: 'POSTED', invoice_date: '2026-09-07' }],
    ap_invoices: [],
    acc_account_roles: [],
    acc_credit_notes: [], acc_credit_note_lines: [], acc_credit_note_allocations: [], acc_credit_note_files: [],
    journal_entries: [], journal_entry_lines: [],
  };
  const sb = fakeSb(tables, {}, [], ['journal_entry_lines']);
  /* scm.settle_odb_received_sen as the migration writes it: clamp to the bill,
     PAID when nothing is owed, a CANCELLED bill takes nothing. */
  sb.rpcHandlers.settle_odb_received_sen = (args: Record<string, unknown>) => {
    const row = (sb.tables.acc_debtor_bills ?? []).find((r) => r.id === args.p_id);
    if (!row) return [{ applied_sen: 0, reason: 'not_found' }];
    if (row.status === 'CANCELLED') return [{ applied_sen: 0, reason: 'not_live' }];
    const old = Number(row.received_sen ?? 0), total = Number(row.total_sen ?? 0), delta = Number(args.p_delta ?? 0);
    const next = delta > 0 ? Math.max(old, Math.min(total, old + delta)) : Math.max(0, old + delta);
    row.received_sen = next;
    row.status = next >= total ? 'PAID' : 'POSTED';
    return [{ applied_sen: next - old, new_received_sen: next, new_status: row.status }];
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: KEYS } as never);
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
  const odb = (id: string) => {
    const r = (sb.tables.acc_debtor_bills ?? []).find((x) => x.id === id)!;
    return { received: Number(r.received_sen), status: String(r.status) };
  };
  return { req, odb, sb };
}

/* CN-2609-025: RM 2,000 off Eastern Decorator's exhibition rental. */
const OCN = (over: Row = {}) => ({
  kind: 'OCN', debtorId: 'deb-e', noteDate: '2026-09-02', sourceDocNo: 'CN-2609-025',
  lines: [{ description: 'DISCOUNT FOR EXHIBITION RENTAL FOR HOMES LIVING 9-12 JUL KLCC', accountCode: '520-0000', amountSen: 200_000 }],
  ...over,
});
const tick = (id: string, amountSen: number) => ({ kind: 'ODB', id, amountSen });

describe('an other-debtor credit note', () => {
  test('raised to a debtor, posted Dr the line / Cr the other-debtor control, its plan knocks the bill off', async () => {
    const { req, odb, sb } = harness();
    const fresh = await req('/credit-notes/knock-off?debtorId=deb-e', 'GET');
    expect(fresh.status).toBe(200);
    expect((fresh.body.rows as Row[]).map((r) => [r.kind, r.number, r.owedSen, r.noteSen])).toEqual([['ODB', 'HC-ODB-2608-005', 6_920_000, 0]]);

    const made = await req('/credit-notes', 'POST', OCN({ allocations: [tick('odb-e', 200_000)] }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const note = made.body.note as Row;
    expect(note).toMatchObject({ kind: 'OCN', party_type: 'ODEBTOR', party_code: null, party_name: 'EASTERN DECORATOR SDN. BHD.', debtor_id: 'deb-e', status: 'DRAFT', total_sen: 200_000 });
    expect(String(note.note_number)).toMatch(/^HC-OCN-2609-\d{3}$/);
    expect(odb('odb-e')).toEqual({ received: 0, status: 'POSTED' });

    const posted = await req(`/credit-notes/${note.id}/post`, 'POST');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.applied).toEqual([{ kind: 'ODB', id: 'odb-e', number: 'HC-ODB-2608-005', appliedSen: 200_000 }]);
    expect(odb('odb-e')).toEqual({ received: 200_000, status: 'POSTED' });

    const je = (sb.tables.journal_entries ?? []).find((j) => j.source_doc_no === note.note_number)!;
    expect(je).toMatchObject({ source_type: 'OCN', entry_date: '2026-09-02', total_debit_sen: 200_000, total_credit_sen: 200_000 });
    const legs = (sb.tables.journal_entry_lines ?? []).filter((l) => l.journal_entry_id === je.id)
      .map((l) => [l.account_code, l.debit_sen, l.credit_sen, l.party_type ?? null, l.party_code ?? null, l.party_name ?? null]);
    expect(legs).toEqual([
      ['520-0000', 200_000, 0, null, null, null],
      ['305-0000', 0, 200_000, 'ODEBTOR', null, 'EASTERN DECORATOR SDN. BHD.'],
    ]);

    const table = await req(`/credit-notes/${note.id}/knock-off`, 'GET');
    expect(table.body).toMatchObject({ totalSen: 200_000, takenSen: 200_000, leftSen: 0, posted: true });
    expect((table.body.rows as Row[]).map((r) => [r.number, r.owedSen, r.noteSen])).toEqual([['HC-ODB-2608-005', 6_920_000, 200_000]]);
  });

  test('untick gives the bill its money back; cancel reverses the journal and gives back what is left', async () => {
    const { req, odb, sb } = harness();
    const made = await req('/credit-notes', 'POST', OCN({ allocations: [tick('odb-e', 200_000)] }));
    const id = String((made.body.note as Row).id);
    await req(`/credit-notes/${id}/post`, 'POST');
    const untick = await req(`/credit-notes/${id}/allocations`, 'PUT', { targets: [] });
    expect(untick.status, JSON.stringify(untick.body)).toBe(200);
    expect(odb('odb-e')).toEqual({ received: 0, status: 'POSTED' });
    await req(`/credit-notes/${id}/allocations`, 'PUT', { targets: [tick('odb-e', 150_000)] });
    expect(odb('odb-e')).toEqual({ received: 150_000, status: 'POSTED' });

    const cancelled = await req(`/credit-notes/${id}/cancel`, 'POST');
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(odb('odb-e')).toEqual({ received: 0, status: 'POSTED' });
    expect((sb.tables.acc_credit_note_allocations ?? []).filter((a) => a.note_id === id)).toEqual([]);
    expect((sb.tables.journal_entries ?? []).some((j) => j.source_type === 'OCN_REVERSAL')).toBe(true);
  });

  test('refusals: no debtor, a line with no account, another debtor\'s bill, a supplier\'s invoice', async () => {
    const { req } = harness();
    const noDebtor = await req('/credit-notes', 'POST', OCN({ debtorId: '' }));
    expect(noDebtor.status).toBe(400);
    expect(noDebtor.body.error).toBe('debtor_required');
    const noAccount = await req('/credit-notes', 'POST', OCN({ lines: [{ description: 'Discount', amountSen: 200_000 }] }));
    expect(noAccount.status).toBe(400);
    expect(noAccount.body.error).toBe('account_required');
    const theirs = await req('/credit-notes', 'POST', OCN({ allocations: [tick('odb-t', 100_000)] }));
    expect(theirs.status).toBe(400);
    expect(theirs.body).toMatchObject({ error: 'invoice_not_this_debtor', message: "That bill is not one of this debtor's here — pick it again." });
    const supplierDoc = await req('/credit-notes', 'POST', OCN({ allocations: [{ kind: 'PI', id: 'pi-1', amountSen: 100_000 }] }));
    expect(supplierDoc.status).toBe(400);
    expect(supplierDoc.body).toMatchObject({ error: 'bad_target', message: 'Each line names a debtor bill.' });
  });

  test('the two pages: side=AR is the customer\'s and the other debtor\'s notes, side=AP the supplier\'s', async () => {
    const { req } = harness();
    await req('/credit-notes', 'POST', OCN());
    await req('/credit-notes', 'POST', { kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-21', lines: [{ description: 'Rebate', amountSen: 10_000 }] });
    await req('/credit-notes', 'POST', { kind: 'CN', partyName: 'WALK-IN', noteDate: '2026-09-21', lines: [{ description: 'Return', amountSen: 5_000 }] });
    const ar = await req('/credit-notes?side=AR', 'GET');
    expect((ar.body.rows as Row[]).map((r) => r.kind).sort()).toEqual(['CN', 'OCN']);
    const ap = await req('/credit-notes?side=AP', 'GET');
    expect((ap.body.rows as Row[]).map((r) => r.kind)).toEqual(['SCN']);
  });

  /* Owner 2026-10-29: the opening's supplier credits (AutoCount payments not knocked
     off at 31/08) on their own "Opening 31/08" tab, apart from the real notes. */
  test('opening=exclude leaves the opening papers out, opening=only lists them alone', async () => {
    const { req, sb } = harness();
    await req('/credit-notes', 'POST', { kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-21', lines: [{ description: 'Rebate', amountSen: 10_000 }] });
    sb.tables.acc_credit_notes!.push({
      id: 'n-open', company_id: CO, note_number: 'HC-SCN-2601-010', kind: 'SCN', party_type: 'SUPPLIER', supplier_id: 'sup-d',
      note_date: '2026-01-30', total_sen: 2_000_000, status: 'POSTED', opening: true,
      reason: 'Opening 31/08 from AutoCount: AutoCount payment not knocked off HPV-2601-188',
    });
    for (const n of sb.tables.acc_credit_notes!) if (n.opening === undefined) n.opening = false;
    const notes = await req('/credit-notes?side=AP&opening=exclude', 'GET');
    expect((notes.body.rows as Row[]).map((r) => r.opening)).toEqual([false]);
    const opening = await req('/credit-notes?side=AP&opening=only', 'GET');
    expect((opening.body.rows as Row[]).map((r) => r.note_number)).toEqual(['HC-SCN-2601-010']);
    const both = await req('/credit-notes?side=AP', 'GET');
    expect(both.body.rows as Row[]).toHaveLength(2);
  });
});
