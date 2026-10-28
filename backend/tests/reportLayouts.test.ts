// The report layout routes (owner 2026-09-14, docs/bugs/0911: 我要能自己调动排版，
// 然后能自己加大 categories … 做公用然后选要不要，类似 chart of account). Pinned:
//   • the statements' key opens the layout and nothing else does;
//   • with nothing saved, GET hands over the chart's own tree, the chart
//     union the editor arranges (one row per code, each company's tick
//     beside it) and the companies the ticks name;
//   • PUT checks the tree and names what is wrong, saves ONE row per report
//     (a second save replaces, never duplicates), and a tick belonging to a
//     company outside the caller's grants rides through the save untouched;
//   • DELETE puts the chart's tree back;
//   • the P&L hands its figures back on the stored tree — % of sales on
//     every line, the unplaced under Unassigned — and on the chart's tree
//     when nothing is stored.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { reportLayoutGet, reportLayoutPut, reportLayoutReset } from '../src/scm/routes/accounting-report-layouts';
import { pnlReport } from '../src/scm/routes/accounting-reports';

const chart = (company_id: number, account_code: string, account_name: string, account_type: string, parent_code: string | null, section: string, is_active = true): Row =>
  ({ company_id, account_code, account_name, account_type, parent_code, section, is_active });

/* Two companies on one chart: 2990 carries 900-A014 unticked, HOUZS alone carries 900-H010. */
const CHART: Row[] = [
  ...[1, 2].flatMap((co) => [
    chart(co, '501-0000', 'SALES', 'INCOME', null, 'SALES'),
    chart(co, '900-0000', 'Operating Expense', 'EXPENSE', null, 'EXPENSES'),
    chart(co, '900-A001', 'ACCOUNTING FEE', 'EXPENSE', '900-0000', 'EXPENSES'),
    chart(co, '900-A002', 'ADVERTISEMENT', 'EXPENSE', '900-0000', 'EXPENSES'),
    chart(co, '900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', '900-A002', 'EXPENSES', co === 1),
  ]),
  chart(1, '900-H010', 'HOMESTAY EXPENSES', 'EXPENSE', '900-0000', 'EXPENSES'),
];

const gl = (code: string, type: string, dr: number, cr: number): Row => ({
  company_id: 2, account_code: code, account_type: type, account_name: code,
  debit_sen: dr, credit_sen: cr, entry_date: '2026-08-15', posted: true, reversed: false,
});
const WORLD: Row[] = [
  gl('501-0000', 'INCOME', 0, 100_000),
  gl('900-A001', 'EXPENSE', 12_000, 0),
  gl('900-A014', 'EXPENSE', 3_000, 0),
];

const marketing = (hiddenFor?: number[]) => ({
  version: 1,
  blocks: {
    tradingIncome: [], costOfSales: [], otherIncome: [], taxation: [],
    expenses: [{ kind: 'category', id: 'cat:mkt', label: 'Marketing', ...(hiddenFor ? { hiddenFor } : {}), children: [{ kind: 'account', code: '900-A001' }] }],
  },
});

function harness(opts: { perms?: string[]; allowed?: number[]; layouts?: Row[]; gl?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    accounts: CHART.map((r) => ({ ...r })),
    acc_report_layouts: opts.layouts ?? [],
    v_gl_entries: opts.gl ?? [],
  };
  const sb = fakeSb(tables);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 2 as never);
    c.set('allowedCompanyIds' as never, (opts.allowed ?? [1, 2]) as never);
    c.set('companies' as never, [{ id: 1, code: 'HOUZS', name: 'Houzs' }, { id: 2, code: '2990', name: '2990 Home' }] as never);
    c.set('houzsUser' as never, { name: 'Finance', permissions_set: opts.perms ?? ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/accounting/reports/layout', reportLayoutGet as never);
  app.put('/accounting/reports/layout', reportLayoutPut as never);
  app.delete('/accounting/reports/layout', reportLayoutReset as never);
  app.get('/accounting/reports/pnl', pnlReport as never);
  return { app, tables };
}

const put = (app: Hono, layout: unknown, report = 'pnl') =>
  app.request(`/accounting/reports/layout?report=${report}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout }) });

type Item = { kind: string; id?: string; code?: string; label?: string; hiddenFor?: number[]; children?: Item[] };
const shape = (items: Item[]): unknown[] => items.map((it) => (it.kind === 'account' ? it.code : { [it.id!]: shape(it.children ?? []) }));

describe('the layout routes', () => {
  test('the statements\' key opens them; without it every verb is a 403', async () => {
    const { app } = harness({ perms: ['scm.so.read'] });
    expect((await app.request('/accounting/reports/layout?report=pnl')).status).toBe(403);
    expect((await put(app, marketing())).status).toBe(403);
    expect((await app.request('/accounting/reports/layout?report=pnl', { method: 'DELETE' })).status).toBe(403);
  });

  test('an unknown report is a 400 that names the ones there are', async () => {
    const { app } = harness();
    const res = await app.request('/accounting/reports/layout?report=ebitda');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('pnl, balance_sheet, performance, rp');
  });

  test('each of the four reports has its own tree, on its own row (docs/bugs/0912)', async () => {
    const { app, tables } = harness();
    const blocksOf = async (report: string) => {
      const res = await app.request(`/accounting/reports/layout?report=${report}`);
      expect(res.status).toBe(200);
      const b = (await res.json()) as { blocks: Array<{ key: string }>; layout: { blocks: Record<string, Item[]> } };
      return { keys: b.blocks.map((x) => x.key), tree: b.layout.blocks };
    };
    expect((await blocksOf('balance_sheet')).keys).toEqual(['assets', 'liabilities', 'equity']);
    expect((await blocksOf('performance')).keys).toEqual(['otherIncome', 'expenses']);
    const rp = await blocksOf('rp');
    expect(rp.keys).toEqual(['accounts']);
    /* The chart of the harness: sales and expenses only — so the Cash Flow tree is those two sections, once as RECEIPTS (In) and once as PAYMENTS (Out). */
    const sides = (side: 'in' | 'out') => [{ [`${side}:sec:SALES`]: ['501-0000'] }, { [`${side}:sec:EXPENSES`]: [{ [`${side}:acc:900-0000`]: ['900-A001', { [`${side}:acc:900-A002`]: ['900-A014'] }, '900-H010'] }] }];
    expect(shape(rp.tree.accounts!)).toEqual([{ 'side:in': sides('in') }, { 'side:out': sides('out') }]);
    /* Saving the performance tree touches no other report's row. */
    const perfTree = { version: 1, blocks: { otherIncome: [], expenses: [{ kind: 'category', id: 'cat:ops', label: 'Ops', children: [{ kind: 'account', code: '900-A001' }] }] } };
    expect((await put(app, perfTree, 'performance')).status).toBe(200);
    expect((await put(app, marketing(), 'pnl')).status).toBe(200);
    expect(tables.acc_report_layouts.map((r) => r.report).sort()).toEqual(['performance', 'pnl']);
    expect(shape((await blocksOf('performance')).tree.expenses!)).toEqual([{ 'cat:ops': ['900-A001'] }]);
    expect(shape((await blocksOf('pnl')).tree.expenses!)).toEqual([{ 'cat:mkt': ['900-A001'] }]);
  });

  test('a Cash Flow tree saved before directions existed reads as RECEIPTS (In) over PAYMENTS (Out) — stored, ticks kept, never refused (2026-09-18)', async () => {
    const legacy = { version: 1, blocks: { accounts: [{ kind: 'category', id: 'cat:x', label: 'X', hiddenFor: [1], children: [{ kind: 'account', code: '900-A001' }] }] } };
    const { app } = harness({ layouts: [{ report: 'rp', tree: legacy, updated_at: null, updated_by: 'T' }] });
    const res = await app.request('/accounting/reports/layout?report=rp');
    const b = (await res.json()) as { stored: boolean; layout: { blocks: Record<string, Array<Item & { flow?: string; totalLabel?: string }>> } };
    expect(b.stored).toBe(true);
    expect(shape(b.layout.blocks.accounts!)).toEqual([{ 'side:in': [{ 'in:cat:x': ['900-A001'] }] }, { 'side:out': [{ 'out:cat:x': ['900-A001'] }] }]);
    expect(b.layout.blocks.accounts!.map((t) => [t.flow, t.totalLabel, t.children?.[0]?.hiddenFor])).toEqual([['in', 'Total receipts', [1]], ['out', 'Total payments', [1]]]);
    /* A PUT of that legacy shape is upgraded the same way and saved typed. */
    expect((await put(app, legacy, 'rp')).status).toBe(200);
    const again = (await (await app.request('/accounting/reports/layout?report=rp')).json()) as { layout: { blocks: Record<string, Item[]> } };
    expect(shape(again.layout.blocks.accounts!)[0]).toEqual({ 'side:in': [{ 'in:cat:x': ['900-A001'] }] });
  });

  test('nothing saved: the chart\'s own tree, the union with each company\'s tick, the companies', async () => {
    const { app } = harness();
    const res = await app.request('/accounting/reports/layout?report=pnl');
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      stored: boolean; updatedBy: string | null; blocks: Array<{ key: string; title: string }>;
      layout: { version: number; blocks: Record<string, Item[]> };
      companies: Array<{ id: number; code: string }>;
      accounts: Array<{ code: string; name: string; parentCode: string | null; perCompany: Record<string, { active: boolean }> }>;
    };
    expect(b.stored).toBe(false);
    expect(b.updatedBy).toBeNull();
    expect(b.blocks.map((x) => x.title)).toEqual(['Trading income', 'Cost of sales', 'Other income', 'Expenses', 'Taxation']);
    expect(shape(b.layout.blocks.expenses!)).toEqual([
      { 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }, '900-H010'] },
    ]);
    expect(shape(b.layout.blocks.tradingIncome!)).toEqual([{ 'sec:SALES': ['501-0000'] }]);
    expect(b.companies).toEqual([{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }]);
    /* One row per code; the ticks say who carries it. */
    expect(b.accounts.map((a) => a.code)).toEqual(['501-0000', '900-0000', '900-A001', '900-A002', '900-A014', '900-H010']);
    expect(b.accounts.find((a) => a.code === '900-A014')!.perCompany).toEqual({ 1: { active: true }, 2: { active: false } });
    expect(b.accounts.find((a) => a.code === '900-H010')!.perCompany).toEqual({ 1: { active: true } });
  });

  test('PUT names what is wrong with a tree, saves a good one ONCE, and a second save replaces it', async () => {
    const { app, tables } = harness();
    const twice = marketing();
    twice.blocks.costOfSales.push({ kind: 'account', code: '900-A001' } as never);
    const bad = await put(app, twice);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_layout', message: '900-A001 is placed twice.' });
    expect(tables.acc_report_layouts).toHaveLength(0);

    const ok = await put(app, marketing());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, report: 'pnl', stored: true, updatedBy: 'Finance' });
    expect(tables.acc_report_layouts).toHaveLength(1);

    const renamed = marketing();
    renamed.blocks.expenses[0]!.label = 'Marketing & advertising';
    expect((await put(app, renamed)).status).toBe(200);
    expect(tables.acc_report_layouts).toHaveLength(1);

    const back = (await (await app.request('/accounting/reports/layout?report=pnl')).json()) as { stored: boolean; updatedBy: string; layout: { blocks: Record<string, Item[]> } };
    expect(back.stored).toBe(true);
    expect(back.updatedBy).toBe('Finance');
    expect(back.layout.blocks.expenses![0]!.label).toBe('Marketing & advertising');
  });

  test('a tick belongs to its company: another company\'s untick rides through a save, and the caller cannot set it', async () => {
    /* A 2990-only session; HOUZS had unticked Marketing earlier. */
    const stored = { report: 'pnl', tree: marketing([1]), updated_at: '2026-09-14T00:00:00Z', updated_by: 'Houzs Finance' };
    const { app } = harness({ allowed: [2], layouts: [stored] });
    const cat = async (): Promise<Item> => {
      const b = (await (await app.request('/accounting/reports/layout?report=pnl')).json()) as { layout: { blocks: Record<string, Item[]> } };
      return b.layout.blocks.expenses![0]!;
    };
    expect((await cat()).hiddenFor).toEqual([1]);

    /* Saving with no ticks at all leaves HOUZS's untick where it was. */
    expect((await put(app, marketing())).status).toBe(200);
    expect((await cat()).hiddenFor).toEqual([1]);

    /* 2990 unticks for itself: both stand. */
    expect((await put(app, marketing([2]))).status).toBe(200);
    expect((await cat()).hiddenFor).toEqual([1, 2]);

    /* 2990 ticks itself back on; HOUZS's untick still stands. */
    expect((await put(app, marketing([]))).status).toBe(200);
    expect((await cat()).hiddenFor).toEqual([1]);
  });

  test('a caller cannot untick for a company outside their grants', async () => {
    const { app } = harness({ allowed: [2] });
    expect((await put(app, marketing([1]))).status).toBe(200);
    const b = (await (await app.request('/accounting/reports/layout?report=pnl')).json()) as { layout: { blocks: Record<string, Item[]> } };
    expect(b.layout.blocks.expenses![0]!.hiddenFor).toBeUndefined();
  });

  test('DELETE puts the chart\'s tree back', async () => {
    const { app, tables } = harness({ layouts: [{ report: 'pnl', tree: marketing(), updated_at: null, updated_by: 'T' }] });
    const res = await app.request('/accounting/reports/layout?report=pnl', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; stored: boolean; layout: { blocks: Record<string, Item[]> } };
    expect(b.stored).toBe(false);
    expect(shape(b.layout.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }, '900-H010'] }]);
    expect(tables.acc_report_layouts).toHaveLength(0);
  });

  test('a stored tree that no longer validates is ignored for the chart\'s, never a 500', async () => {
    const { app } = harness({ layouts: [{ report: 'pnl', tree: { version: 7 }, updated_at: null, updated_by: 'T' }] });
    const res = await app.request('/accounting/reports/layout?report=pnl');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stored: boolean }).stored).toBe(false);
  });
});

type Laid = { kind: string; label: string; code?: string; amountSen: number; pct: number | null; children: Laid[] };
const flat = (nodes: Laid[]): unknown[] =>
  nodes.map((n) => [n.kind, n.label, n.amountSen, n.pct, ...(n.children.length > 0 ? [flat(n.children)] : [])]);

describe('the P&L on its layout', () => {
  test('the stored tree: % of sales on every line, the unplaced under Unassigned, the total unchanged', async () => {
    const { app } = harness({ gl: WORLD, layouts: [{ report: 'pnl', tree: marketing(), updated_at: null, updated_by: 'T' }] });
    const res = await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    const b = (await res.json()) as { layout: { stored: boolean; baseSen: number | null; expenses: Laid[]; tradingIncome: Laid[] }; totals: { expensesSen: number } };
    expect(b.layout.stored).toBe(true);
    expect(b.layout.baseSen).toBe(100_000);
    expect(flat(b.layout.expenses)).toEqual([
      ['category', 'Marketing', 12_000, 12, [['account', '900-A001 · 900-A001', 12_000, 12]]],
      ['unassigned', 'Unassigned', 3_000, 3, [['account', '900-A014 · 900-A014', 3_000, 3]]],
    ]);
    expect(b.layout.expenses.reduce((s, n) => s + n.amountSen, 0)).toBe(b.totals.expensesSen);
    /* An empty stored block still lays the section's figures out — under Unassigned. */
    expect(flat(b.layout.tradingIncome)).toEqual([['unassigned', 'Unassigned', 100_000, 100, [['account', '501-0000 · 501-0000', 100_000, 100]]]]);
  });

  test('nothing stored: the chart\'s own tree, headers as categories with subtotals', async () => {
    const { app } = harness({ gl: WORLD });
    const b = (await (await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31')).json()) as { layout: { stored: boolean; expenses: Laid[] } };
    expect(b.layout.stored).toBe(false);
    expect(flat(b.layout.expenses)).toEqual([
      ['category', 'Operating Expense', 15_000, 15, [
        ['account', '900-A001 · 900-A001', 12_000, 12],
        ['category', 'ADVERTISEMENT', 3_000, 3, [['account', '900-A014 · 900-A014', 3_000, 3]]],
      ]],
    ]);
  });

  test('no sales in the period: every % is null, never a division by nothing', async () => {
    const { app } = harness({ gl: WORLD.filter((r) => r.account_code !== '501-0000') });
    const b = (await (await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31')).json()) as { layout: { baseSen: number | null; expenses: Laid[] } };
    expect(b.layout.baseSen).toBeNull();
    expect(b.layout.expenses[0]!.pct).toBeNull();
    expect(b.layout.expenses[0]!.children.every((n) => n.pct === null)).toBe(true);
  });
});
