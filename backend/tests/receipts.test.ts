/* Receipts — the contract (owner 2026-09-03): a GENERAL receipt takes a typed
   payer (no registry), a money account and free-pick credit lines, POSTS
   DIRECTLY (不需要走四层，就录入就好), and the only undo is VOID (错就
   delete 或 void → RCT_REVERSAL + CANCELLED, never a vanish). The list is the
   unified money-in view: general + debtor receipts + customer sales payments,
   month-windowed. Same harness family as tests/otherDebtors.test.ts, real
   engine posting into the fake tables. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { receipts } from '../src/scm/routes/receipts';

type Row = Record<string, any>;
const CO = 1;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private inserted: Row[] = [];
  private patch: Row = {};
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  gte(col: string, val: unknown) { this.preds.push((r) => String(r[col]) >= String(val)); return this; }
  lt(col: string, val: unknown) { this.preds.push((r) => String(r[col]) < String(val)); return this; }
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
  range() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
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

function harness(tables: Record<string, Row[]>) {
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
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.route('/', receipts);
  return app;
}

const thisMonth = new Date().toISOString().slice(0, 7);

const baseTables = (): Record<string, Row[]> => ({
  accounts: [
    { company_id: CO, account_code: '310-0010', account_name: 'MAYBANK', acc_money: true, is_active: true },
    { company_id: CO, account_code: '700-0000', account_name: 'Other Income', acc_money: false, is_active: true },
    { company_id: CO, account_code: '400-0000', account_name: 'AP', acc_money: false, is_active: true, special_type: 'SCC' },
  ],
  acc_receipts: [],
  acc_receipt_lines: [],
  acc_debtor_receipts: [
    { id: 'dr1', company_id: CO, receipt_number: 'HC-ODR-2609-001', receipt_date: `${thisMonth}-02`, bank_account_code: '310-0010', total_sen: 20000, status: 'POSTED', debtor_id: 'd1', debtor: { name: 'AHMAD' } },
  ],
  mfg_sales_order_payments: [
    { id: 'p1', company_id: CO, so_doc_no: 'HC-SO-2609-004', paid_at: `${thisMonth}-01T10:00:00Z`, method: 'EDC', amount_sen: 350000, is_deposit: true },
  ],
  journal_entries: [],
  journal_entry_lines: [],
});

const post = (app: Hono, path: string, body?: Row) => app.request(path, {
  method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' },
});

describe('the general receipt — record and post, one motion', () => {
  test('creates, posts RCT (Dr bank / Cr each line), and shows in the unified month list beside debtor + customer rows', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const res = await post(app, '/', {
      payerName: 'ALLIANZ INSURANCE',
      receiptDate: `${thisMonth}-03`,
      bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88800 }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const made = (await res.json() as { receipt: { receiptNumber: string; totalSen: number } }).receipt;
    expect(made.totalSen).toBe(88800);

    const je = tables.journal_entries.find((j) => j.source_type === 'RCT' && j.source_doc_no === made.receiptNumber)!;
    expect(je, 'the RCT journal exists').toBeTruthy();
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(jl.find((l) => l.account_code === '310-0010')).toMatchObject({ debit_sen: 88800, party_name: 'ALLIANZ INSURANCE' });
    expect(jl.find((l) => l.account_code === '700-0000')).toMatchObject({ credit_sen: 88800 });

    const list = await app.request(`/?month=${thisMonth}`);
    const body = await list.json() as { receipts: Array<Row> };
    expect(body.receipts.map((r) => r.kind).sort()).toEqual(['CUSTOMER', 'DEBTOR', 'GENERAL']);
    expect(body.receipts.find((r) => r.kind === 'GENERAL')).toMatchObject({ payer: 'ALLIANZ INSURANCE', totalSen: 88800, status: 'POSTED' });
    expect(body.receipts.find((r) => r.kind === 'CUSTOMER')).toMatchObject({ number: 'HC-SO-2609-004', totalSen: 350000, status: 'RECEIVED' });
    expect(body.receipts.find((r) => r.kind === 'DEBTOR')).toMatchObject({ payer: 'AHMAD' });
  });

  /* 月份只是筛选 (owner 2026-09-08): the list opens on every month; a month
     narrows it; a malformed month is refused rather than read as "this month". */
  test('no month asked for lists every month; ?month= narrows; junk is a 400', async () => {
    const tables = baseTables();
    tables.mfg_sales_order_payments.push({ id: 'p0', company_id: CO, so_doc_no: 'HC-SO-2601-009', paid_at: '2026-01-15T10:00:00Z', method: 'cash', amount_sen: 12000, is_deposit: false });
    const app = harness(tables);

    const all = await (await app.request('/')).json() as { month: string | null; receipts: Array<Row> };
    expect(all.month).toBeNull();
    expect(all.receipts.map((r) => r.number).sort()).toEqual(['HC-ODR-2609-001', 'HC-SO-2601-009', 'HC-SO-2609-004']);

    const jan = await (await app.request('/?month=2026-01')).json() as { month: string | null; receipts: Array<Row> };
    expect(jan.month).toBe('2026-01');
    expect(jan.receipts.map((r) => r.number)).toEqual(['HC-SO-2601-009']);

    expect((await (await app.request('/?month=all')).json() as { receipts: Row[] }).receipts).toHaveLength(3);
    expect((await app.request('/?month=2026-13')).status).toBe(400);
  });

  test('a control-account line refuses; a non-money landing account refuses', async () => {
    const app = harness(baseTables());
    const control = await post(app, '/', {
      payerName: 'X', bankAccountCode: '310-0010',
      lines: [{ creditAccountCode: '400-0000', amountSen: 100 }],
    });
    expect(control.status).toBe(400);
    expect((await control.json() as { error: string }).error).toBe('control_account_locked');

    const notMoney = await post(app, '/', {
      payerName: 'X', bankAccountCode: '700-0000',
      lines: [{ creditAccountCode: '700-0000', amountSen: 100 }],
    });
    expect(notMoney.status).toBe(400);
    expect((await notMoney.json() as { error: string }).error).toBe('not_a_money_account');
  });

  test('void reverses the journal, flips CANCELLED, and refuses a second void', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const res = await post(app, '/', {
      payerName: 'ALLIANZ', bankAccountCode: '310-0010',
      lines: [{ creditAccountCode: '700-0000', amountSen: 500 }],
    });
    expect(res.status).toBe(201);
    const row = tables.acc_receipts[0]!;

    const voided = await post(app, `/${row.id}/void`);
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect(row.status).toBe('CANCELLED');
    expect(tables.journal_entries.some((j) => j.source_type === 'RCT_REVERSAL')).toBe(true);

    const again = await post(app, `/${row.id}/void`);
    expect(again.status).toBe(409);
  });
});

describe('the number follows the receipt date (owner 2026-09-07: 要根据文件日期)', () => {
  test('a receipt dated in February mints OR-2602 whatever today is', async () => {
    const app = harness(baseTables());
    const res = await post(app, '/', {
      payerName: 'ALLIANZ INSURANCE', receiptDate: '2026-02-10', bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88800 }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json() as { receipt: { receiptNumber: string } }).receipt.receiptNumber).toMatch(/-OR-2602-001$/);
  });
});

describe('edit and re-post (owner 2026-09-07: 收钱的日期错了 → 做 b)', () => {
  const patch = (app: Hono, path: string, body: Row) => app.request(path, {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });

  test('changing the date re-posts — the old RCT is reversed as it was dated, a fresh RCT lands on the new date, the number stays', async () => {
    const tables = baseTables();
    const app = harness(tables);
    const res = await post(app, '/', {
      payerName: 'HOUZS VENTURE HOLDING SDN BHD', receiptDate: `${thisMonth}-07`, bankAccountCode: '310-0010',
      lines: [{ description: 'capital', creditAccountCode: '700-0000', amountSen: 10000000 }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const made = (await res.json() as { receipt: { receiptNumber: string } }).receipt;
    const row = tables.acc_receipts[0]!;

    const edited = await patch(app, `/${row.id}`, { receiptDate: '2026-08-28' });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const body = await edited.json() as { reposted: boolean; jeNo: string; receipt: { receiptNumber: string; receiptDate: string; totalSen: number } };
    expect(body.reposted).toBe(true);
    expect(body.receipt).toMatchObject({ receiptNumber: made.receiptNumber, receiptDate: '2026-08-28', totalSen: 10000000 });
    expect(row).toMatchObject({ receipt_number: made.receiptNumber, receipt_date: '2026-08-28', status: 'POSTED' });

    const rct = tables.journal_entries.filter((j) => j.source_type === 'RCT' && j.source_doc_no === made.receiptNumber);
    expect(rct).toHaveLength(2);
    expect(rct[0]).toMatchObject({ entry_date: `${thisMonth}-07`, reversed: true });
    expect(rct[1]).toMatchObject({ entry_date: '2026-08-28' });
    expect(rct[1]!.reversed).toBeFalsy();
    const contra = tables.journal_entries.find((j) => j.source_type === 'RCT_REVERSAL')!;
    expect(contra).toBeTruthy();
    expect(String(contra.entry_date)).toBe(`${thisMonth}-07`);
    /* The lines were kept as they were (none sent) and the new entry books them. */
    const jl = tables.journal_entry_lines.filter((l) => l.journal_entry_id === rct[1]!.id);
    expect(jl.find((l) => l.account_code === '310-0010')).toMatchObject({ debit_sen: 10000000, party_name: 'HOUZS VENTURE HOLDING SDN BHD' });
    expect(jl.find((l) => l.account_code === '700-0000')).toMatchObject({ credit_sen: 10000000 });

    const detail = await app.request(`/${row.id}`);
    expect(detail.status).toBe(200);
    const d = await detail.json() as { receipt: Row; lines: Row[] };
    expect(d.receipt).toMatchObject({ receipt_number: made.receiptNumber, receipt_date: '2026-08-28' });
    expect(d.lines).toHaveLength(1);
  });

  test('payer, bank and lines change too, with the same doors as create; a cancelled receipt is left alone', async () => {
    const tables = baseTables();
    tables.accounts.push({ company_id: CO, account_code: '320-0000', account_name: 'CASH', acc_money: true, is_active: true });
    const app = harness(tables);
    const res = await post(app, '/', {
      payerName: 'ALLIANZ', bankAccountCode: '310-0010',
      lines: [{ creditAccountCode: '700-0000', amountSen: 500 }],
    });
    expect(res.status).toBe(201);
    const row = tables.acc_receipts[0]!;

    const notMoney = await patch(app, `/${row.id}`, { bankAccountCode: '700-0000' });
    expect(notMoney.status).toBe(400);
    const control = await patch(app, `/${row.id}`, { lines: [{ creditAccountCode: '400-0000', amountSen: 100 }] });
    expect(control.status).toBe(400);

    const ok = await patch(app, `/${row.id}`, {
      payerName: 'ALLIANZ INSURANCE', bankAccountCode: '320-0000',
      lines: [{ description: 'claim', creditAccountCode: '700-0000', amountSen: 700 }, { creditAccountCode: '700-0000', amountSen: 300 }],
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(row).toMatchObject({ payer_name: 'ALLIANZ INSURANCE', bank_account_code: '320-0000', total_sen: 1000 });
    expect(tables.acc_receipt_lines.filter((l) => l.receipt_id === row.id)).toHaveLength(2);
    const active = tables.journal_entries.filter((j) => j.source_type === 'RCT' && !j.reversed);
    expect(active).toHaveLength(1);
    expect(tables.journal_entry_lines.filter((l) => l.journal_entry_id === active[0]!.id).find((l) => l.account_code === '320-0000')).toMatchObject({ debit_sen: 1000 });

    const voided = await post(app, `/${row.id}/void`);
    expect(voided.status).toBe(200);
    const afterVoid = await patch(app, `/${row.id}`, { receiptDate: '2026-08-01' });
    expect(afterVoid.status).toBe(409);
    expect((await afterVoid.json() as { error: string }).error).toBe('receipt_cancelled');
  });
});
