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

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private inserted: Row[] = [];
  private patch: Row = {};
  private rangeFrom: number | null = null;
  private rangeTo = 0;
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
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
      return withIds;
    }
    let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') {
      for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    }
    if (this.rangeFrom != null) hit = hit.slice(this.rangeFrom, this.rangeTo + 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
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
    const created = await post(app, '/', { name: 'LIM AH KOW', phone: '012-3456789' });
    expect(created.status).toBe(201);

    await makeBill(app, tables);
    const list = await app.request('/');
    const body = await list.json() as { debtors: Row[] };
    const ahmad = body.debtors.find((d) => d.name === 'AHMAD BIN ALI')!;
    expect(ahmad.outstanding_sen).toBe(50000);
    expect(body.debtors.find((d) => d.name === 'LIM AH KOW')!.outstanding_sen).toBe(0);

    const upd = await app.request('/d1', {
      method: 'PATCH', body: JSON.stringify({ phone: '019-888' }), headers: { 'content-type': 'application/json' },
    });
    expect(upd.status).toBe(200);
    expect(tables.acc_debtors.find((d) => d.id === 'd1')!.phone).toBe('019-888');
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
