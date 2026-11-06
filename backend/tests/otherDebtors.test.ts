/* Other Debtors — the contract (owner 2026-09-03, confirmed line by line):
   a registry of counterparties (资料 lives HERE, never as chart sub-accounts),
   a Debtor Bill that posts DIRECTLY (Dr 305-0000 control / Cr the lines' own
   accounts, source ODB), and a Receipt that walks the PV's four layers and
   knocks bills off like an AP Payment — partial included — posting
   Dr bank / Cr 305-0000 (source ODR) on approve.

   The REAL engine posts into the fake tables here, so the assertions read the
   journals the way prod would: an ODB exists the moment its bill does, an ODR
   only after the four layers. Same bare-Hono + fake-PostgREST-shaped harness
   as tests/pvApControlGuard.test.ts, with update/delete taught to the fake. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { otherDebtors } from '../src/scm/routes/other-debtors';

type Row = Record<string, any>;
const CO = 1;

/* A one-shot refusal for the next insert into / update of a table — the
   receipt edit's put-the-old-bills-back path (batch 5 c5) needs a write that fails. */
const failNext: { insertInto: string | null; updateOf: string | null; code?: string } = { insertInto: null, updateOf: null };

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private inserted: Row[] = [];
  private patch: Row = {};
  private rangeFrom: number | null = null;
  private rangeTo = 0;
  private cols: string[] | null = null;
  constructor(private rows: Row[], private table: string) {}
  select(cols?: string) { if (cols) this.cols = cols.split(',').map((s) => s.trim()); return this; }
  /* The registry hands back only the columns a read named, so a column left out of a select fails here as it would in prod. */
  private shaped(rows: Row[]): Row[] {
    const cols = this.cols;
    return this.table === 'acc_debtors' && cols ? rows.map((r) => Object.fromEntries(cols.map((k) => [k, r[k]]))) : rows;
  }
  private refusal(): { message: string; code?: string } | null {
    if ((this.op === 'insert' && failNext.insertInto === this.table) || (this.op === 'update' && failNext.updateOf === this.table)) {
      if (this.op === 'insert') failNext.insertInto = null; else failNext.updateOf = null;
      const code = failNext.code;
      failNext.code = undefined;
      return { message: `${this.op} refused`, ...(code ? { code } : {}) };
    }
    return null;
  }
  order() { return this; }
  limit() { return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  like(col: string, pat: string) {
    const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`).replace(/%/g, '.*').replace(/_/g, '.')}$`);
    this.preds.push((r) => re.test(String(r[col] ?? '')));
    return this;
  }
  range(fromN: number, toN: number) { this.rangeFrom = fromN; this.rangeTo = toN; return this; }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return this.shaped(withIds);
    }
    let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') {
      for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    }
    if (this.rangeFrom != null) hit = hit.slice(this.rangeFrom, this.rangeTo + 1);
    return this.shaped(hit);
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const no = this.refusal();
    if (no) return Promise.resolve({ data: null, error: no });
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const no = this.refusal();
    if (no) return Promise.resolve({ data: null, error: no }).then(res, rej);
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, perms: string[] = ['*']) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  const counters = new Map<string, number>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
      rpc: async (fn: string, args: Row) => {
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        if (fn === 'next_doc_no_n') {
          const series = String(args.p_series);
          const n = Math.max(counters.get(series) ?? 0, Math.max(0, Number(args.p_floor ?? 0)) + 1);
          counters.set(series, n + 1);
          return { data: n, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    } as never);
    c.set('companyId' as never, CO as never);
    /* The router carries the supabaseAuth bridge (docs/bugs/0648). The pinned
       system-staff id is the bridge's own "already translated" mark, so it steps
       aside and the supabase + houzsUser set by hand below stay in force. */
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(perms) } as never);
    await next();
  });
  app.route('/', otherDebtors);
  return app;
}

const baseTables = (): Record<string, Row[]> => ({
  accounts: [
    { company_id: CO, account_code: '305-0000', account_name: 'OTHER DEBTOR', special_type: 'SDC', acc_money: false, is_active: true },
    { company_id: CO, account_code: '310-0010', account_name: 'MAYBANK', special_type: 'SBK', acc_money: true, is_active: true },
    { company_id: CO, account_code: '700-0000', account_name: 'Other Income', acc_money: false, is_active: true },
    { company_id: CO, account_code: '910-0000', account_name: 'Utilities', acc_money: false, is_active: true },
  ],
  acc_account_roles: [],
  acc_debtors: [{ id: 'd1', company_id: CO, name: 'AHMAD BIN ALI', phone: null, notes: null, is_active: true }],
  acc_debtor_bills: [],
  acc_debtor_bill_lines: [],
  acc_debtor_receipts: [],
  acc_debtor_receipt_allocations: [],
  journal_entries: [],
  journal_entry_lines: [],
});

const post = (app: Hono, path: string, body?: Row) => app.request(path, {
  method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' },
});

const makeBill = async (app: Hono, tables: Record<string, Row[]>, amounts = [40000, 10000]) => {
  const res = await post(app, '/d1/bills', {
    billDate: '2026-09-03',
    lines: amounts.map((a, i) => ({ description: `line ${i + 1}`, creditAccountCode: i === 0 ? '700-0000' : '910-0000', amountSen: a })),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json() as { bill: { id: string; billNumber: string; totalSen: number } }).bill;
};

describe('the registry — 资料 lives here, never in the chart', () => {
  test('create, list with outstanding, and update', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const created = await post(app, '/', {
      name: 'LIM AH KOW', phone: '012-3456789', tinNumber: 'IG12345678090', contactPerson: 'LIM',
      address1: '12, JALAN SATU', city: 'PETALING JAYA', postcode: '47810', state: 'Selangor', country: 'Malaysia', email: '   ',
    });
    expect(created.status).toBe(201);
    /* The party's data as the supplier master carries it (owner 2026-09-21: 他要填的资料就和 supplier 的一样) — same columns; a blank is NULL. */
    const lim = tables.acc_debtors.find((d) => d.name === 'LIM AH KOW')!;
    expect([lim.tin_number, lim.contact_person, lim.address1, lim.city, lim.postcode, lim.state, lim.country, lim.email, lim.address2])
      .toEqual(['IG12345678090', 'LIM', '12, JALAN SATU', 'PETALING JAYA', '47810', 'Selangor', 'Malaysia', null, null]);

    await makeBill(app, tables);
    const list = await app.request('/');
    const body = await list.json() as { debtors: Row[] };
    const ahmad = body.debtors.find((d) => d.name === 'AHMAD BIN ALI')!;
    expect(ahmad.outstanding_sen).toBe(50000);
    expect(body.debtors.find((d) => d.name === 'LIM AH KOW')!.outstanding_sen).toBe(0);

    const upd = await app.request('/d1', {
      method: 'PATCH', body: JSON.stringify({ phone: '019-888', address2: 'TAMAN DUA', attention: 'MR AHMAD', fax: '' }), headers: { 'content-type': 'application/json' },
    });
    expect(upd.status).toBe(200);
    const ahmadRow = tables.acc_debtors.find((d) => d.id === 'd1')!;
    expect([ahmadRow.phone, ahmadRow.address2, ahmadRow.attention, ahmadRow.fax]).toEqual(['019-888', 'TAMAN DUA', 'MR AHMAD', null]);
    /* The list and the detail hand the party's data back, so the page and the print can carry it. */
    const listed = ((await (await app.request('/')).json()) as { debtors: Row[] }).debtors.find((d) => d.id === 'd1')!;
    expect([listed.address2, listed.attention]).toEqual(['TAMAN DUA', 'MR AHMAD']);
    const detail = (await (await app.request('/d1')).json()) as { debtor: Row };
    expect([detail.debtor.address2, detail.debtor.attention]).toEqual(['TAMAN DUA', 'MR AHMAD']);
  });
});

describe('the account code — AutoCount style, on screens and prints only (owner 2026-11-03)', () => {
  const coded = (): Record<string, Row[]> => {
    const tables = baseTables();
    tables.acc_debtors[0].code = '305-A001';
    tables.acc_debtors.push({ id: 'd2', company_id: CO, name: 'BENG HOE', phone: null, notes: null, is_active: true, code: '305-B001' });
    tables.acc_debtors.push({ id: 'x9', company_id: 2, name: 'OTHER COMPANY', phone: null, notes: null, is_active: true, code: '305-Z001' });
    return tables;
  };
  const patch = (app: Hono, path: string, body: Row) => app.request(path, {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const codeOf = (tables: Record<string, Row[]>, name: string) => tables.acc_debtors.find((d) => d.name === name)!.code;

  test('a new debtor keeps the code it was given, trimmed and in capitals; a blank or none is no code', async () => {
    const tables = baseTables();
    const app = harness(tables);
    expect((await post(app, '/', { name: 'LIM AH KOW', code: ' 305-l001 ' })).status).toBe(201);
    expect(codeOf(tables, 'LIM AH KOW')).toBe('305-L001');
    expect((await post(app, '/', { name: 'BLANK', code: '   ' })).status).toBe(201);
    expect(codeOf(tables, 'BLANK')).toBeNull();
    expect((await post(app, '/', { name: 'NOT SENT' })).status).toBe(201);
    expect(codeOf(tables, 'NOT SENT')).toBeNull();
  });

  test('the list and the debtor hand the code back', async () => {
    const app = harness(coded());
    const listed = ((await (await app.request('/')).json()) as { debtors: Row[] }).debtors;
    expect(listed.map((d) => [d.name, d.code])).toEqual([['AHMAD BIN ALI', '305-A001'], ['BENG HOE', '305-B001']]);
    const detail = (await (await app.request('/d1')).json()) as { debtor: Row };
    expect(detail.debtor.code).toBe('305-A001');
  });

  test('a code another debtor of the company holds is refused by name, whatever its case', async () => {
    const tables = coded();
    const res = await post(harness(tables), '/', { name: 'AHMAD TWO', code: '305-a001' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'code_taken', message: 'Another debtor already has 305-A001.' });
    expect(tables.acc_debtors.some((d) => d.name === 'AHMAD TWO')).toBe(false);
  });

  test("another company's code is free to use", async () => {
    const tables = coded();
    expect((await post(harness(tables), '/', { name: 'ZED', code: '305-Z001' })).status).toBe(201);
    expect(codeOf(tables, 'ZED')).toBe('305-Z001');
  });

  test("editing: its own code saves, a blank clears it, leaving it out leaves it, another debtor's is refused", async () => {
    const tables = coded();
    const app = harness(tables);
    expect((await patch(app, '/d1', { code: '305-a001', name: 'AHMAD BIN ALI' })).status).toBe(200);
    expect(codeOf(tables, 'AHMAD BIN ALI')).toBe('305-A001');

    expect((await patch(app, '/d1', { code: '305-A777' })).status).toBe(200);
    expect(codeOf(tables, 'AHMAD BIN ALI')).toBe('305-A777');

    expect((await patch(app, '/d1', { phone: '019-888' })).status).toBe(200);
    expect(codeOf(tables, 'AHMAD BIN ALI')).toBe('305-A777');

    const taken = await patch(app, '/d1', { code: '305-b001' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: 'code_taken', message: 'Another debtor already has 305-B001.' });
    expect(codeOf(tables, 'AHMAD BIN ALI')).toBe('305-A777');

    expect((await patch(app, '/d1', { code: '' })).status).toBe(200);
    expect(codeOf(tables, 'AHMAD BIN ALI')).toBeNull();
  });

  test('a save that loses the race to the unique index says the same sentence; any other failure stays a failure', async () => {
    const tables = coded();
    const app = harness(tables);
    failNext.insertInto = 'acc_debtors';
    failNext.code = '23505';
    const made = await post(app, '/', { name: 'RACER', code: '305-R001' });
    expect(made.status).toBe(409);
    expect(await made.json()).toMatchObject({ error: 'code_taken', message: 'Another debtor already has 305-R001.' });

    failNext.updateOf = 'acc_debtors';
    failNext.code = '23505';
    const edited = await patch(app, '/d1', { code: '305-R001' });
    expect(edited.status).toBe(409);
    expect(await edited.json()).toMatchObject({ error: 'code_taken', message: 'Another debtor already has 305-R001.' });

    failNext.insertInto = 'acc_debtors';
    expect((await post(app, '/', { name: 'RACER', code: '305-R002' })).status).toBe(500);
  });

  test('a code longer than 30 characters is refused', async () => {
    const res = await post(harness(coded()), '/', { name: 'LONG', code: 'X'.repeat(31) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'code_too_long', message: 'An account code is 30 characters at most.' });
  });

  test('the code stays off the journals: the bill and the receipt post the same party as ever', async () => {
    const tables = coded();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const res = await post(app, '/d1/receipts', { receiptDate: '2026-09-03', bankAccountCode: '310-0010', allocations: [{ billId: billRow.id, amountSen: 20000 }] });
    const { receipt } = await res.json() as { receipt: { id: string } };
    for (const step of ['submit', 'check', 'approve']) expect((await post(app, `/receipts/${receipt.id}/${step}`)).status).toBe(200);
    const control = tables.journal_entry_lines.filter((l) => l.account_code === '305-0000');
    expect(control).toHaveLength(2);
    for (const l of control) expect([l.party_type, l.party_code ?? null, l.party_name]).toEqual(['ODEBTOR', null, 'AHMAD BIN ALI']);
  });
});

describe('the Debtor Bill — posts directly, Dr control / Cr the lines', () => {
  test('a bill books ODB the moment it exists: Dr 305-0000 total, Cr each line its own account', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    expect(bill.totalSen).toBe(50000);

    const je = tables.journal_entries.find((j) => j.source_type === 'ODB' && j.source_doc_no === bill.billNumber)!;
    expect(je, 'the ODB journal exists').toBeTruthy();
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(jl.find((l) => l.account_code === '305-0000')).toMatchObject({ debit_sen: 50000, credit_sen: 0, party_name: 'AHMAD BIN ALI' });
    expect(jl.find((l) => l.account_code === '700-0000')).toMatchObject({ credit_sen: 40000 });
    expect(jl.find((l) => l.account_code === '910-0000')).toMatchObject({ credit_sen: 10000 });
  });

  test('a line naming the CONTROL itself refuses — the module posts the control, never a typed line', async () => {
    const app = harness(baseTables());
    const res = await post(app, '/d1/bills', { lines: [{ creditAccountCode: '305-0000', amountSen: 100 }] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('control_account_locked');
  });

  test('cancel voids the journal and refuses once money was received', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;

    billRow.received_sen = 100;
    const refused = await post(app, `/bills/${billRow.id}/cancel`);
    expect(refused.status).toBe(409);

    billRow.received_sen = 0;
    const ok = await post(app, `/bills/${billRow.id}/cancel`);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(billRow.status).toBe('CANCELLED');
    expect(tables.journal_entries.some((j) => j.source_type === 'ODB_REVERSAL')).toBe(true);
  });
});

/* Editing a bill (owner 2026-09-06: edit 这个不能全部都设成可以改吗 — the AP
   invoice's rule carried here). A debtor bill is on the books from birth, so
   an edit RE-POSTS: contra the old entry dated as the old bill, then a fresh
   ODB dated as saved. */
describe('text lines (owner 2026-09-21: 有一些我只想放 description 罢了，就是给人看到 detail)', () => {
  test('a line with a description alone is kept on the bill without an account, booked by nobody, outside the total; text lines alone refuse; an empty line refuses', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const res = await post(app, '/d1/bills', {
      billDate: '2026-09-03',
      lines: [
        { description: 'Rental September', creditAccountCode: '700-0000', amountSen: 40000 },
        { description: 'Unit 3A, ground floor, as agreed on 01/09' },
        { description: 'Utilities', creditAccountCode: '910-0000', amountSen: 10000 },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const bill = (await res.json() as { bill: { id: string; billNumber: string; totalSen: number } }).bill;
    expect(bill.totalSen).toBe(50000);
    const rows = tables.acc_debtor_bill_lines.filter((l) => l.bill_id === bill.id).map((l) => [l.line_no, l.description, l.credit_account_code, l.amount_sen]);
    expect(rows).toEqual([
      [1, 'Rental September', '700-0000', 40000],
      [2, 'Unit 3A, ground floor, as agreed on 01/09', null, 0],
      [3, 'Utilities', '910-0000', 10000],
    ]);
    const je = tables.journal_entries.find((j) => j.source_type === 'ODB' && j.source_doc_no === bill.billNumber)!;
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id).map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen)]);
    expect(jl).toEqual([['305-0000', 50000, 0], ['700-0000', 0, 40000], ['910-0000', 0, 10000]]);
    /* The detail hands the text line back with no account, so Edit and Copy carry it. */
    const detail = (await (await app.request('/d1')).json()) as { bills: Array<{ id: string; lines: Row[] }> };
    const got = detail.bills.find((b) => b.id === bill.id)!.lines.map((l) => [l.line_no, l.credit_account_code, l.amount_sen]);
    expect(got).toEqual([[1, '700-0000', 40000], [2, null, 0], [3, '910-0000', 10000]]);

    const textOnly = await post(app, '/d1/bills', { billDate: '2026-09-03', lines: [{ description: 'nothing to charge' }] });
    expect(textOnly.status).toBe(400);
    expect((await textOnly.json() as { error: string }).error).toBe('lines_required');
    const emptyLine = await post(app, '/d1/bills', { billDate: '2026-09-03', lines: [{ description: 'Rental', creditAccountCode: '700-0000', amountSen: 100 }, { description: '' }] });
    expect(emptyLine.status).toBe(400);
    expect((await emptyLine.json() as { error: string }).error).toBe('bad_line');

    /* An edit keeps a text line through the re-post: stored without an account, absent from the fresh journal. */
    const edited = await app.request(`/bills/${bill.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: [{ description: 'Rental September', creditAccountCode: '700-0000', amountSen: 45000 }, { description: 'Unit 3A, ground floor' }] }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(tables.acc_debtor_bill_lines.filter((l) => l.bill_id === bill.id).map((l) => [l.credit_account_code, l.amount_sen])).toEqual([['700-0000', 45000], [null, 0]]);
    const live = tables.journal_entries.filter((j) => j.source_type === 'ODB' && j.source_doc_no === bill.billNumber && !j.reversed);
    expect(live).toHaveLength(1);
    expect(tables.journal_entry_lines.filter((l) => l.journal_entry_id === live[0]!.id).map((l) => [l.account_code, Number(l.credit_sen)])).toEqual([['305-0000', 0], ['700-0000', 45000]]);
  });
});

describe('editing a bill — every field, the journal re-posted', () => {
  const patchBill = (app: Hono, billId: string, body: Row) => app.request(`/bills/${billId}`, {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });

  test('lines and date change: the old ODB gets a contra dated as the old bill, a fresh ODB books the new lines dated as saved; the detail hands each bill its lines', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables); // 2026-09-03: 700-0000 400.00 + 910-0000 100.00
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const firstJe = tables.journal_entries.find((j) => j.source_type === 'ODB' && j.source_doc_no === bill.billNumber)!;

    const res = await patchBill(app, billRow.id, {
      billDate: '2026-09-15', notes: '改了',
      lines: [{ description: 'rent', creditAccountCode: '700-0000', amountSen: 65000 }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { reposted: boolean; jeNo: string; bill: { totalSen: number } };
    expect(body.reposted).toBe(true);
    expect(body.bill.totalSen).toBe(65000);
    expect(billRow.total_sen).toBe(65000);
    expect(billRow.bill_date).toBe('2026-09-15');
    expect(billRow.notes).toBe('改了');
    const lines = tables.acc_debtor_bill_lines.filter((l) => l.bill_id === billRow.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ credit_account_code: '700-0000', amount_sen: 65000, line_no: 1 });

    /* The contra: dated as the OLD bill was, undoing the first entry. */
    const contra = tables.journal_entries.find((j) => j.source_type === 'ODB_REVERSAL')!;
    expect(contra, 'the contra exists').toBeTruthy();
    expect(contra.entry_date).toBe('2026-09-03');
    const contraLines = tables.journal_entry_lines.filter((l) => l.journal_entry_id === contra.id);
    expect(contraLines.find((l) => l.account_code === '305-0000')).toMatchObject({ debit_sen: 0, credit_sen: 50000 });

    /* The fresh entry: the bill as saved, dated as saved, through the one gate. */
    const fresh = tables.journal_entries.filter((j) => j.source_type === 'ODB' && j.source_doc_no === bill.billNumber && j.id !== firstJe.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.entry_date).toBe('2026-09-15');
    expect(fresh[0]!.je_no).toBe(body.jeNo);
    const freshLines = tables.journal_entry_lines.filter((l) => l.journal_entry_id === fresh[0]!.id);
    expect(freshLines.find((l) => l.account_code === '305-0000')).toMatchObject({ debit_sen: 65000, credit_sen: 0, party_name: 'AHMAD BIN ALI' });
    expect(freshLines.find((l) => l.account_code === '700-0000')).toMatchObject({ credit_sen: 65000 });
    expect(freshLines.find((l) => l.account_code === '910-0000')).toBeUndefined();

    /* The detail hands each bill its lines — Edit and Copy start from them. */
    const detail = await app.request('/d1');
    expect(detail.status).toBe(200);
    const d = await detail.json() as { bills: Array<{ lines: Row[] }> };
    expect(d.bills[0]!.lines.map((l) => [l.credit_account_code, l.amount_sen])).toEqual([['700-0000', 65000]]);
  });

  test('a second edit re-posts again — the live entry is the one contra\'d, never the already-voided one', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    expect((await patchBill(app, billRow.id, { lines: [{ creditAccountCode: '700-0000', amountSen: 65000 }] })).status).toBe(200);
    const again = await patchBill(app, billRow.id, { lines: [{ creditAccountCode: '910-0000', amountSen: 70000 }] });
    expect(again.status, await again.clone().text()).toBe(200);
    expect(billRow.total_sen).toBe(70000);
    const contras = tables.journal_entries.filter((j) => j.source_type === 'ODB_REVERSAL');
    expect(contras).toHaveLength(2);
    /* Net on the control after two edits = the latest total only. */
    const onControl = tables.journal_entry_lines.filter((l) => l.account_code === '305-0000');
    expect(onControl.reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0)).toBe(70000);
  });

  test('money already received caps the total; a cancelled bill refuses; a control account on a line refuses — and a refusal leaves the books alone', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;

    billRow.received_sen = 30000;
    const low = await patchBill(app, billRow.id, { lines: [{ creditAccountCode: '700-0000', amountSen: 20000 }] });
    expect(low.status).toBe(409);
    expect((await low.json() as { error: string }).error).toBe('total_below_received');

    const control = await patchBill(app, billRow.id, { lines: [{ creditAccountCode: '305-0000', amountSen: 60000 }] });
    expect(control.status).toBe(400);
    expect((await control.json() as { error: string }).error).toBe('control_account_locked');

    billRow.status = 'CANCELLED';
    const dead = await patchBill(app, billRow.id, { notes: 'x' });
    expect(dead.status).toBe(409);
    expect((await dead.json() as { error: string }).error).toBe('cancelled');

    expect(billRow.total_sen).toBe(50000);
    expect(tables.journal_entries.filter((j) => j.source_type === 'ODB_REVERSAL')).toHaveLength(0);
    expect(tables.acc_debtor_bill_lines.filter((l) => l.bill_id === billRow.id)).toHaveLength(2);
  });
});

describe('the Receipt — four layers, partial knock-off, Dr bank / Cr control', () => {
  const raise = async (app: Hono, amountSen: number, billId: string) => {
    const res = await post(app, '/d1/receipts', {
      receiptDate: '2026-09-03', bankAccountCode: '310-0010',
      allocations: [{ billId, amountSen }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json() as { receipt: { id: string; receiptNumber: string } }).receipt;
  };

  test('partial receipt: the four layers gate the post, the bill keeps its remainder', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;

    const receipt = await raise(app, 20000, billRow.id);

    /* Approve before check refuses — the layers are real. */
    expect((await post(app, `/receipts/${receipt.id}/approve`)).status).toBe(409);
    expect((await post(app, `/receipts/${receipt.id}/check`)).status).toBe(409); // not prepared yet
    expect((await post(app, `/receipts/${receipt.id}/submit`)).status).toBe(200);
    expect((await post(app, `/receipts/${receipt.id}/check`)).status).toBe(200);
    const approved = await post(app, `/receipts/${receipt.id}/approve`);
    expect(approved.status, await approved.clone().text()).toBe(200);

    expect(billRow.received_sen).toBe(20000);
    expect(billRow.status).toBe('POSTED'); // partial — not PAID
    const je = tables.journal_entries.find((j) => j.source_type === 'ODR')!;
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(jl.find((l) => l.account_code === '310-0010')).toMatchObject({ debit_sen: 20000 });
    expect(jl.find((l) => l.account_code === '305-0000')).toMatchObject({ credit_sen: 20000 });

    /* The rest arrives; the bill flips PAID. */
    const rest = await raise(app, 30000, billRow.id);
    await post(app, `/receipts/${rest.id}/submit`);
    await post(app, `/receipts/${rest.id}/check`);
    expect((await post(app, `/receipts/${rest.id}/approve`)).status).toBe(200);
    expect(billRow.received_sen).toBe(50000);
    expect(billRow.status).toBe('PAID');
  });

  test('over-allocation refuses at raise time; reject clears every mark (一律退回 Draft)', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;

    const over = await post(app, '/d1/receipts', {
      bankAccountCode: '310-0010', allocations: [{ billId: billRow.id, amountSen: 60000 }],
    });
    expect(over.status).toBe(400);
    expect((await over.json() as { error: string }).error).toBe('over_allocation');

    const receipt = await raise(app, 50000, billRow.id);
    await post(app, `/receipts/${receipt.id}/submit`);
    await post(app, `/receipts/${receipt.id}/check`);
    const rej = await post(app, `/receipts/${receipt.id}/reject`, { note: '银行不对' });
    expect(rej.status).toBe(200);
    const row = tables.acc_debtor_receipts.find((x) => x.id === receipt.id)!;
    expect(row.submitted_at).toBeNull();
    expect(row.checked_at).toBeNull();
    expect(String(row.notes)).toContain('银行不对');
  });

  /* The Receipts page's door (owner 2026-09-08: 不可能链接起来吗 … 用这个方式):
     postNow raises AND books in one call — the same entry the fourth layer
     writes, the three marks stamped by the one hand that keyed it. */
  test('postNow books the receipt in the same call: POSTED, marks stamped, Dr bank / Cr control, the bill knocked off', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;

    const res = await post(app, '/d1/receipts', {
      receiptDate: '2026-09-08', bankAccountCode: '310-0010', postNow: true,
      allocations: [{ billId: billRow.id, amountSen: 50000 }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await res.json() as { posted: boolean; jeNo: string; receipt: { id: string; receiptNumber: string; totalSen: number } };
    expect(body.posted).toBe(true);
    expect(body.receipt.totalSen).toBe(50000);

    const row = tables.acc_debtor_receipts.find((x) => x.id === body.receipt.id)!;
    expect(row.status).toBe('POSTED');
    expect(row.submitted_at && row.checked_at && row.approved_at && row.posted_at).toBeTruthy();
    expect(billRow.received_sen).toBe(50000);
    expect(billRow.status).toBe('PAID');
    const je = tables.journal_entries.find((j) => j.source_type === 'ODR' && j.source_doc_no === body.receipt.receiptNumber)!;
    expect(je.je_no).toBe(body.jeNo);
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(jl.find((l) => l.account_code === '310-0010')).toMatchObject({ debit_sen: 50000 });
    expect(jl.find((l) => l.account_code === '305-0000')).toMatchObject({ credit_sen: 50000 });
    /* Already posted: the fourth layer has nothing left to do. */
    expect((await post(app, `/receipts/${body.receipt.id}/approve`)).status).toBe(409);
  });

  test('without postNow nothing changes — the receipt starts at Draft as before', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const receipt = await raise(app, 20000, billRow.id);
    const row = tables.acc_debtor_receipts.find((x) => x.id === receipt.id)!;
    expect(row.status).toBe('DRAFT');
    expect(row.submitted_at ?? null).toBeNull();
    expect(billRow.received_sen ?? 0).toBe(0);
    expect(tables.journal_entries.filter((j) => j.source_type === 'ODR')).toHaveLength(0);
  });

  test('the receipt lands on MONEY only', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const res = await post(app, '/d1/receipts', {
      bankAccountCode: '700-0000', allocations: [{ billId: billRow.id, amountSen: 100 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('not_a_money_account');
  });
});

/* Changing a receipt nobody has checked yet (the owner's Claude Design, batch 5
   §4.3 c5) — the payment voucher's rule (pvCanEdit): a Draft or a Prepared
   receipt changes in place and keeps its stage and number; a checked or posted
   one refuses. The same checks as raising it, and nothing posts. */
describe('editing a receipt before it is checked — posts nothing, keeps its stage', () => {
  const patch = (app: Hono, path: string, body: Row) => app.request(path, {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const raise = async (app: Hono, billId: string, amountSen: number, extra: Row = {}) => {
    const res = await post(app, '/d1/receipts', { receiptDate: '2026-09-03', bankAccountCode: '310-0010', allocations: [{ billId, amountSen }], ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json() as { receipt: { id: string; receiptNumber: string } }).receipt;
  };
  const allocsOf = (tables: Record<string, Row[]>, receiptId: string) =>
    tables.acc_debtor_receipt_allocations.filter((a) => a.receipt_id === receiptId).map((a) => [a.bill_id, a.amount_sen]);
  const withHlb = () => {
    const tables = baseTables();
    tables.accounts.push({ company_id: CO, account_code: '310-0020', account_name: 'HONG LEONG', special_type: 'SBK', acc_money: true, is_active: true });
    return tables;
  };

  test('a prepared receipt changes its date, bank and bills; the stage and number stay; approval books what was saved', async () => {
    const tables = withHlb();
    const app = harness(tables);
    const first = await makeBill(app, tables);
    const second = await makeBill(app, tables, [30000]);
    const row1 = tables.acc_debtor_bills.find((b) => b.bill_number === first.billNumber)!;
    const row2 = tables.acc_debtor_bills.find((b) => b.bill_number === second.billNumber)!;
    const receipt = await raise(app, row1.id, 20000);
    expect((await post(app, `/receipts/${receipt.id}/submit`)).status).toBe(200);

    const res = await patch(app, `/receipts/${receipt.id}`, {
      receiptDate: '2026-09-10', bankAccountCode: '310-0020',
      allocations: [{ billId: row1.id, amountSen: 10000 }, { billId: row2.id, amountSen: 30000 }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, receipt: { id: receipt.id, receiptNumber: receipt.receiptNumber, totalSen: 40000, stage: 'Prepared' } });
    const row = tables.acc_debtor_receipts.find((x) => x.id === receipt.id)!;
    expect(row).toMatchObject({ receipt_number: receipt.receiptNumber, receipt_date: '2026-09-10', bank_account_code: '310-0020', total_sen: 40000, status: 'DRAFT' });
    expect(row.submitted_at).toBeTruthy();
    expect(allocsOf(tables, receipt.id)).toEqual([[row1.id, 10000], [row2.id, 30000]]);
    /* Nothing posted, no bill touched. */
    expect(tables.journal_entries.filter((j) => j.source_type === 'ODR')).toHaveLength(0);
    expect(row1.received_sen).toBe(0);
    expect(row2.received_sen).toBe(0);

    /* The layers carry on with what was saved. */
    expect((await post(app, `/receipts/${receipt.id}/check`)).status).toBe(200);
    expect((await post(app, `/receipts/${receipt.id}/approve`)).status).toBe(200);
    expect(row1.received_sen).toBe(10000);
    expect(row2.received_sen).toBe(30000);
    const je = tables.journal_entries.find((j) => j.source_type === 'ODR')!;
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(jl.find((l) => l.account_code === '310-0020')).toMatchObject({ debit_sen: 40000 });
    expect(jl.find((l) => l.account_code === '305-0000')).toMatchObject({ credit_sen: 40000 });
  });

  test('the same checks as raising it — and a refused change leaves the draft as it was', async () => {
    const tables = withHlb();
    tables.acc_debtors.push({ id: 'd2', company_id: CO, name: 'SITI', phone: null, notes: null, is_active: true });
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const other = await post(app, '/d2/bills', { billDate: '2026-09-03', lines: [{ description: 'x', creditAccountCode: '700-0000', amountSen: 5000 }] });
    expect(other.status).toBe(201);
    const otherId = (await other.json() as { bill: { id: string } }).bill.id;
    const receipt = await raise(app, billRow.id, 20000);
    const refused = async (body: Row) => {
      const res = await patch(app, `/receipts/${receipt.id}`, body);
      expect(res.status).toBe(400);
      return (await res.json() as { error: string }).error;
    };
    expect(await refused({ allocations: [{ billId: billRow.id, amountSen: 60000 }] })).toBe('over_allocation');
    expect(await refused({ allocations: [{ billId: otherId, amountSen: 100 }] })).toBe('bad_allocation');
    expect(await refused({ allocations: [{ billId: billRow.id, amountSen: 10.5 }] })).toBe('bad_allocation');
    expect(await refused({ allocations: [] })).toBe('allocations_required');
    expect(await refused({ bankAccountCode: '700-0000' })).toBe('not_a_money_account');
    expect(await refused({ bankAccountCode: '' })).toBe('bank_required');
    expect(await refused({ receiptDate: '' })).toBe('bad_date');
    expect(await refused({})).toBe('nothing_to_change');
    const row = tables.acc_debtor_receipts.find((x) => x.id === receipt.id)!;
    expect(row).toMatchObject({ receipt_date: '2026-09-03', bank_account_code: '310-0010', total_sen: 20000 });
    expect(allocsOf(tables, receipt.id)).toEqual([[billRow.id, 20000]]);
  });

  test('a failed write puts the old bills back, so the total and the knock-off never disagree', async () => {
    const tables = withHlb();
    const app = harness(tables);
    const first = await makeBill(app, tables);
    const second = await makeBill(app, tables, [30000]);
    const row1 = tables.acc_debtor_bills.find((b) => b.bill_number === first.billNumber)!;
    const row2 = tables.acc_debtor_bills.find((b) => b.bill_number === second.billNumber)!;
    const receipt = await raise(app, row1.id, 20000);
    const change = { allocations: [{ billId: row2.id, amountSen: 30000 }] };

    failNext.insertInto = 'acc_debtor_receipt_allocations';
    expect((await patch(app, `/receipts/${receipt.id}`, change)).status).toBe(500);
    expect(allocsOf(tables, receipt.id)).toEqual([[row1.id, 20000]]);

    failNext.updateOf = 'acc_debtor_receipts';
    expect((await patch(app, `/receipts/${receipt.id}`, change)).status).toBe(500);
    expect(allocsOf(tables, receipt.id)).toEqual([[row1.id, 20000]]);
    expect(tables.acc_debtor_receipts.find((x) => x.id === receipt.id)).toMatchObject({ total_sen: 20000 });
  });

  test('a checked or posted receipt refuses; the raise / write keys gate it', async () => {
    const tables = withHlb();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const checked = await raise(app, billRow.id, 10000);
    await post(app, `/receipts/${checked.id}/submit`);
    await post(app, `/receipts/${checked.id}/check`);
    const locked = await patch(app, `/receipts/${checked.id}`, { receiptDate: '2026-09-11' });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: 'already_checked', message: `${checked.receiptNumber} has been checked — it is locked. Reject it back to Draft to change it.` });

    const posted = await raise(app, billRow.id, 10000, { postNow: true });
    const onBooks = await patch(app, `/receipts/${posted.id}`, { receiptDate: '2026-09-11' });
    expect(onBooks.status).toBe(409);
    expect((await onBooks.json() as { error: string }).error).toBe('not_editable');

    const draft = await raise(app, billRow.id, 5000);
    const viewer = harness(tables, ['scm.access', 'scm.payment_voucher.check']);
    expect((await patch(viewer, `/receipts/${draft.id}`, { receiptDate: '2026-09-11' })).status).toBe(403);
    const raiser = harness(tables, ['scm.access', 'scm.payment_voucher.create']);
    expect((await patch(raiser, `/receipts/${draft.id}`, { receiptDate: '2026-09-11' })).status).toBe(200);
    expect((await patch(app, '/receipts/nope', { receiptDate: '2026-09-11' })).status).toBe(404);
  });
});

/* Void (owner 2026-09-29, the Other Debtors page now the registry alone and
   the Receipts page the one door for the money): a POSTED receipt's one undo
   — the ODR contra, the bills' money given back, the receipt CANCELLED; a
   draft and a void one refuse; the cancel key gates it. */
describe('voiding a posted receipt — the ODR contra, the money back on the bills', () => {
  const raisePosted = async (app: Hono, billId: string, amountSen: number) => {
    const res = await post(app, '/d1/receipts', { receiptDate: '2026-09-08', bankAccountCode: '310-0010', postNow: true, allocations: [{ billId, amountSen }] });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json() as { receipt: { id: string; receiptNumber: string } }).receipt;
  };

  test('void reverses the ODR, gives the bill its money back (PAID → POSTED) and turns the receipt CANCELLED; twice refuses', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const receipt = await raisePosted(app, billRow.id, 50000);
    expect(billRow.status).toBe('PAID');

    const voided = await post(app, `/receipts/${receipt.id}/void`);
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect(tables.acc_debtor_receipts.find((x) => x.id === receipt.id)!.status).toBe('CANCELLED');
    expect(billRow.received_sen).toBe(0);
    expect(billRow.status).toBe('POSTED');
    /* The ledger keeps both sides: the original marked reversed, the contra the mirror of it. */
    const orig = tables.journal_entries.find((j) => j.source_type === 'ODR' && j.source_doc_no === receipt.receiptNumber)!;
    expect(orig.reversed).toBe(true);
    const contra = tables.journal_entries.find((j) => j.id !== orig.id && String(j.source_type).startsWith('ODR'))!;
    expect(contra).toBeTruthy();
    const cl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === contra.id);
    expect(cl.find((l) => l.account_code === '310-0010')).toMatchObject({ credit_sen: 50000 });
    expect(cl.find((l) => l.account_code === '305-0000')).toMatchObject({ debit_sen: 50000 });

    const again = await post(app, `/receipts/${receipt.id}/void`);
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toBe('void_twice');
    expect(billRow.received_sen).toBe(0);
  });

  test('a partial receipt gives back only its own slice; a draft is not voidable; the cancel key is required', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const bill = await makeBill(app, tables);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;
    const first = await raisePosted(app, billRow.id, 20000);
    const second = await raisePosted(app, billRow.id, 30000);
    expect(billRow.received_sen).toBe(50000);

    expect((await post(app, `/receipts/${first.id}/void`)).status).toBe(200);
    expect(billRow.received_sen).toBe(30000);
    expect(billRow.status).toBe('POSTED');
    expect(tables.acc_debtor_receipts.find((x) => x.id === second.id)!.status).toBe('POSTED');

    const draftRes = await post(app, '/d1/receipts', { bankAccountCode: '310-0010', allocations: [{ billId: billRow.id, amountSen: 10000 }] });
    const draft = (await draftRes.json() as { receipt: { id: string } }).receipt;
    const notPosted = await post(app, `/receipts/${draft.id}/void`);
    expect(notPosted.status).toBe(409);
    expect((await notPosted.json() as { error: string }).error).toBe('not_posted');

    const noKey = harness(tables, ['scm.payment_voucher.create']);
    expect((await post(noKey, `/receipts/${second.id}/void`)).status).toBe(403);
  });
});

describe('numbers follow the document date (owner 2026-09-07: 要根据文件日期)', () => {
  test('a March bill mints ODB-2603 and its March receipt ODR-2603 whatever today is; a later date edit keeps the number', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const made = await post(app, '/d1/bills', { billDate: '2026-03-15', lines: [{ creditAccountCode: '700-0000', amountSen: 50000 }] });
    expect(made.status, await made.clone().text()).toBe(201);
    const bill = (await made.json() as { bill: { id: string; billNumber: string } }).bill;
    expect(bill.billNumber).toMatch(/-ODB-2603-001$/);
    const billRow = tables.acc_debtor_bills.find((b) => b.bill_number === bill.billNumber)!;

    const rec = await post(app, '/d1/receipts', {
      receiptDate: '2026-03-20', bankAccountCode: '310-0010', allocations: [{ billId: billRow.id, amountSen: 20000 }],
    });
    expect(rec.status, await rec.clone().text()).toBe(201);
    expect((await rec.json() as { receipt: { receiptNumber: string } }).receipt.receiptNumber).toMatch(/-ODR-2603-001$/);

    /* 单据存了后改日期号码不要重发 — the number is an id, not a date. */
    const edited = await app.request(`/bills/${billRow.id}`, {
      method: 'PATCH', body: JSON.stringify({ billDate: '2026-04-02' }), headers: { 'content-type': 'application/json' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(billRow.bill_date).toBe('2026-04-02');
    expect(billRow.bill_number).toBe(bill.billNumber);
  });
});

/* An event on a bill line (owner 2026-10-01, payment-request item 6: other
   debtor 单也要，但不是一定要选) — optional. Posting carries it onto the line's
   OWN credit leg, never the control; an edit's contra and fresh entry carry it,
   so a rental billed back to an organiser nets per event. An event the company
   does not have, or a malformed id, is refused before anything is written.
   public.projects is a small fake of the DB binding (lib/event-tags.ts). */
describe('an event on a bill line — optional, onto its own credit leg', () => {
  const EVENTS = [
    { id: 348, company_id: CO, name: 'Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE' },
    { id: 900, company_id: 2, name: "Another company's fair" },
  ];
  const projectsDb = {
    prepare(sql: string) {
      return {
        bind(...vals: unknown[]) {
          return {
            async all() {
              const co = /p\.company_id = (\d+)/.exec(sql);
              return { results: EVENTS.filter((e) => (!co || e.company_id === Number(co[1])) && vals.map(Number).includes(e.id)) };
            },
          };
        },
      };
    },
  };
  const send = (app: Hono, method: string, path: string, body: Row) =>
    app.request(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, { DB: projectsDb });
  const netOn = (tables: Record<string, Row[]>, projectId: number | null) =>
    tables.journal_entry_lines.filter((l) => (l.project_id ?? null) === projectId && l.account_code !== '305-0000')
      .reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);

  test('a tagged line posts its credit leg with the event, the control leg never; untagged and text lines stay untagged; the detail hands it back', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const res = await send(app, 'POST', '/d1/bills', {
      billDate: '2026-09-28',
      lines: [
        { description: 'Rental share — MLE Penang', creditAccountCode: '700-0000', amountSen: 150000, projectId: 348 },
        { description: 'Electricity', creditAccountCode: '910-0000', amountSen: 20000 },
        { description: 'A note on the paper', projectId: 348 },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const billRow = tables.acc_debtor_bills[0]!;
    expect(tables.acc_debtor_bill_lines.filter((l) => l.bill_id === billRow.id).map((l) => [l.line_no, l.project_id])).toEqual([[1, 348], [2, null], [3, null]]);
    const je = tables.journal_entries.find((j) => j.source_type === 'ODB')!;
    const legs = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(legs.map((l) => [l.account_code, l.project_id ?? null])).toEqual([['305-0000', null], ['700-0000', 348], ['910-0000', null]]);
    const detail = await (await app.request('/d1')).json() as { bills: Array<{ lines: Row[] }> };
    expect(detail.bills[0]!.lines.map((l) => l.project_id ?? null)).toEqual([348, null, null]);
  });

  test("an edit re-posts with the event: a date-only edit keeps the lines' events, a lines edit moves them — the contra always undoes the tagged leg", async () => {
    const tables = baseTables();
    const app = harness(tables);
    expect((await send(app, 'POST', '/d1/bills', { billDate: '2026-09-28', lines: [{ creditAccountCode: '700-0000', amountSen: 150000, projectId: 348 }] })).status).toBe(201);
    const billRow = tables.acc_debtor_bills[0]!;
    expect(netOn(tables, 348)).toBe(-150000);

    const dateOnly = await send(app, 'PATCH', `/bills/${billRow.id}`, { billDate: '2026-09-29' });
    expect(dateOnly.status, await dateOnly.clone().text()).toBe(200);
    expect(netOn(tables, 348)).toBe(-150000);

    const moved = await send(app, 'PATCH', `/bills/${billRow.id}`, { lines: [{ creditAccountCode: '700-0000', amountSen: 120000 }] });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(netOn(tables, 348)).toBe(0);
    expect(netOn(tables, null)).toBe(-120000);
  });

  test("an event of another company, or a malformed id, is refused before anything is written — on a new bill and on an edit", async () => {
    const tables = baseTables();
    const app = harness(tables);
    const other = await send(app, 'POST', '/d1/bills', { lines: [{ creditAccountCode: '700-0000', amountSen: 100, projectId: 900 }] });
    expect(other.status).toBe(400);
    expect((await other.json() as { error: string }).error).toBe('event_not_found');
    const bad = await send(app, 'POST', '/d1/bills', { lines: [{ creditAccountCode: '700-0000', amountSen: 100, projectId: 'abc' }] });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { message: string }).message).toMatch(/^Line 1: projectId must be an event id/);
    expect(tables.acc_debtor_bills).toHaveLength(0);
    expect(tables.journal_entries).toHaveLength(0);

    expect((await send(app, 'POST', '/d1/bills', { lines: [{ creditAccountCode: '700-0000', amountSen: 100 }] })).status).toBe(201);
    const billRow = tables.acc_debtor_bills[0]!;
    const editOther = await send(app, 'PATCH', `/bills/${billRow.id}`, { lines: [{ creditAccountCode: '700-0000', amountSen: 100, projectId: 900 }] });
    expect(editOther.status).toBe(400);
    expect(tables.journal_entries).toHaveLength(1);
    expect(tables.acc_debtor_bill_lines.filter((l) => l.bill_id === billRow.id).map((l) => l.project_id ?? null)).toEqual([null]);
  });
});

/* A debit note to an other debtor (owner 2026-10-28: Customer & Other Debtor CN / DN):
   the same bill — it raises what they owe and is received by the same receipts —
   with doc_kind DN, its own series and its own name in the journal. */
describe('a debit note to an other debtor is a bill of its own kind', () => {
  test('mints {co}ODN-YYMM-NNN and books ODB as "Debit note"; a bad docKind refuses', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const res = await post(app, '/d1/bills', { billDate: '2026-09-03', docKind: 'DN', lines: [{ description: 'Late fee', creditAccountCode: '700-0000', amountSen: 12000 }] });
    expect(res.status, await res.clone().text()).toBe(201);
    const bill = (await res.json() as { bill: { id: string; billNumber: string; totalSen: number } }).bill;
    expect(bill.billNumber).toMatch(/ODN-2609-001$/);
    expect(tables.acc_debtor_bills.find((b) => b.id === bill.id)).toMatchObject({ doc_kind: 'DN', status: 'POSTED', total_sen: 12000 });
    const je = tables.journal_entries.find((j) => j.source_type === 'ODB' && j.source_doc_no === bill.billNumber)!;
    expect(String(je.narration)).toMatch(/^Debit note .*ODN-2609-001 — AHMAD BIN ALI$/);
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(jl.find((l) => l.account_code === '305-0000')).toMatchObject({ debit_sen: 12000, party_name: 'AHMAD BIN ALI' });
    const plain = await makeBill(app, tables);
    expect(plain.billNumber).toMatch(/ODB-2609-001$/);
    const bad = await post(app, '/d1/bills', { billDate: '2026-09-03', docKind: 'XX', lines: [{ creditAccountCode: '700-0000', amountSen: 100 }] });
    expect(bad.status).toBe(400);
  });
});
