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
