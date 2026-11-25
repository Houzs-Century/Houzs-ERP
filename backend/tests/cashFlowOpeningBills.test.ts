/* Cash Flow: a payment of an opening bill (owner 2026-11-25). An opening bill's own
   line is the opening clearing, which says nothing of what was bought, so its
   payment reads by its supplier's own live bills in the ERP:
     • all on one account → that account;
     • on several accounts that print directly under ONE Cash Flow category → a
       line of that category's own, "Opening bills (AutoCount)", with no code;
     • spread over categories, or no bill in the ERP → the creditor control;
     • an advance knocked off against an opening bill later reads the same way;
       what is still ahead of any bill stays on the creditor control;
     • paid out of the trade-finance account → TF-AP, as before.
   Drafts, cancelled bills, other opening bills and another company's bills of
   the same supplier never count. Real handler, fake PostgREST; every name and
   figure is made up. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport, TRADE_FINANCE_AP } from '../src/scm/routes/accounting-rp';
import { openingBillHome } from '../src/acc/opening-bill-places';

const CO = 2;
const OTHER_CO = 3;
const BANK = '310-0010';
const TF_BANK = '310-0060';
let lineId = 0;
const gl = (jeNo: string, date: string, doc: string, code: string, name: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: 'PV', source_doc_no: doc,
  account_code: code, account_name: name, debit_sen: dr, credit_sen: cr, party_type: null, party_name: null, notes: null,
  posted: true, reversed: false, ...extra,
});
/* A supplier payment: Dr the creditor control (the supplier named) / Cr the bank. */
const pay = (jeNo: string, date: string, doc: string, party: string, sen: number, bank = BANK): Row[] => [
  gl(jeNo, date, doc, '400-0000', 'ACCOUNT PAYABLE', sen, 0, { party_type: 'SUPPLIER', party_name: party }),
  gl(jeNo, date, doc, bank, bank === BANK ? 'CASH AT BANK - MAYBANK' : 'CASH AT BANK - MAYBANK (TRADE FINANCE)', 0, sen),
];
const acct = (code: string, name: string, money = false): Row =>
  ({ company_id: CO, account_code: code, account_name: name, acc_money: money, is_active: true, account_type: money ? 'ASSET' : 'EXPENSE', section: money ? 'CURRENT ASSETS' : 'EXPENSES' });
const bill = (id: string, supplier: string, status: string, opening: boolean, company = CO): Row =>
  ({ id, company_id: company, invoice_number: id.toUpperCase(), supplier_id: supplier, status, opening });
const line = (invoice: string, code: string, sen: number, company = CO): Row =>
  ({ id: `ln-${++lineId}`, company_id: company, invoice_id: invoice, debit_account_code: code, amount_sen: sen });
const alloc = (pv: string, invoice: string, sen: number, fromAdvance = false): Row =>
  ({ id: `al-${++lineId}`, company_id: CO, pv_id: pv, pi_id: null, ap_invoice_id: invoice, amount_sen: sen, applied_sen: sen, from_advance: fromAdvance });

/* The Cash Flow tree: the creditor control, an exhibition category with a transport
   category inside it, and an office category, all Out. */
const TREE = {
  version: 1,
  blocks: {
    accounts: [
      {
        kind: 'category', id: 'cf:out', label: 'OPERATIONS OUTFLOWS', flow: 'out', children: [
          { kind: 'category', id: 'cf:ap', label: 'ACCOUNT PAYABLES & CREDITOR', children: [{ kind: 'account', code: '400-0000', flow: 'net' }] },
          {
            kind: 'category', id: 'cf:exh', label: 'EXHIBITION', children: [
              { kind: 'account', code: '900-X001', flow: 'net' },
              { kind: 'account', code: '900-X002', flow: 'net' },
              { kind: 'category', id: 'cf:exh:lorry', label: 'TRANSPORT', children: [{ kind: 'account', code: '900-X003', flow: 'net' }] },
            ],
          },
          { kind: 'category', id: 'cf:office', label: 'OFFICE', children: [{ kind: 'account', code: '900-X004', flow: 'net' }] },
          { kind: 'category', id: 'cf:tf', label: 'TRADE FINANCE AP', children: [{ kind: 'account', code: TRADE_FINANCE_AP, flow: 'net' }] },
        ],
      },
    ],
  },
};

const world = () => fakeSb({
  accounts: [
    acct(BANK, 'CASH AT BANK - MAYBANK', true),
    acct(TF_BANK, 'CASH AT BANK - MAYBANK (TRADE FINANCE)', true),
    { company_id: CO, account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', acc_money: false, is_active: true, account_type: 'LIABILITY', section: 'CURRENT LIABILITIES' },
    { company_id: CO, account_code: '190-0000', account_name: 'OPENING BALANCE CLEARING', acc_money: false, is_active: true, account_type: 'EQUITY', section: 'EQUITY' },
    acct('900-X001', 'STAND BUILD'),
    acct('900-X002', 'HALL RENTAL'),
    acct('900-X003', 'LORRY HIRE'),
    acct('900-X004', 'STATIONERY'),
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* Opening money in the two banks, before the period. */
    gl('JE-0', '2026-08-31', 'OB', BANK, 'CASH AT BANK - MAYBANK', 500000, 0, { source_type: 'MANUAL' }),
    gl('JE-0', '2026-08-31', 'OB', '190-0000', 'OPENING BALANCE CLEARING', 0, 500000, { source_type: 'MANUAL' }),
    gl('JE-0T', '2026-08-31', 'OB', TF_BANK, 'CASH AT BANK - MAYBANK (TRADE FINANCE)', 100000, 0, { source_type: 'MANUAL' }),
    gl('JE-0T', '2026-08-31', 'OB', '190-0000', 'OPENING BALANCE CLEARING', 0, 100000, { source_type: 'MANUAL' }),
    ...pay('JE-A', '2026-09-03', 'PV-A', 'STANDWORKS', 50000),
    ...pay('JE-B', '2026-09-04', 'PV-B', 'FAIRHALL', 30000),
    ...pay('JE-C', '2026-09-05', 'PV-C', 'ROADMOVE', 20000),
    ...pay('JE-D', '2026-09-06', 'PV-D', 'OLDTRADER', 10000),
    /* Paid ahead (no bill ticked); 60.00 of it knocked off against an opening bill later. */
    ...pay('JE-E', '2026-09-07', 'PV-E', 'STANDWORKS', 8000),
    ...pay('JE-F', '2026-09-08', 'PV-F', 'STANDWORKS', 4000, TF_BANK),
  ],
  payment_vouchers: ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => ({ id: `pv-${x.toLowerCase()}`, company_id: CO, pv_number: `PV-${x}`, status: 'POSTED' })),
  pv_allocations: [
    alloc('pv-a', 'ob-a', 50000),
    alloc('pv-b', 'ob-b', 30000),
    alloc('pv-c', 'ob-c', 20000),
    alloc('pv-d', 'ob-d', 10000),
    alloc('pv-e', 'ob-e', 6000, true),
    alloc('pv-f', 'ob-f', 4000),
  ],
  purchase_invoices: [],
  ap_invoices: [
    /* The opening bills: each one line on the opening clearing. */
    bill('ob-a', 'sup-stand', 'PAID', true), bill('ob-e', 'sup-stand', 'PAID', true), bill('ob-f', 'sup-stand', 'PAID', true),
    bill('ob-a2', 'sup-stand', 'POSTED', true),
    bill('ob-b', 'sup-hall', 'PAID', true),
    bill('ob-c', 'sup-road', 'PAID', true),
    bill('ob-d', 'sup-old', 'PAID', true),
    /* STANDWORKS's own bills: two live ones on the stand account; a draft and a cancelled one
       elsewhere, and another company's bill of the same supplier, which never count. */
    bill('api-s1', 'sup-stand', 'POSTED', false), bill('api-s2', 'sup-stand', 'PAID', false),
    bill('api-sd', 'sup-stand', 'DRAFT', false), bill('api-sc', 'sup-stand', 'CANCELLED', false),
    bill('api-sx', 'sup-stand', 'PAID', false, OTHER_CO),
    /* FAIRHALL: the stand and the hall, both directly under EXHIBITION. */
    bill('api-h1', 'sup-hall', 'PAID', false), bill('api-h2', 'sup-hall', 'PARTIALLY_PAID', false),
    /* ROADMOVE: the stand (EXHIBITION) and the lorry (TRANSPORT, inside it) — two categories. */
    bill('api-r1', 'sup-road', 'PAID', false), bill('api-r2', 'sup-road', 'POSTED', false),
    /* OLDTRADER has no bill in the ERP. */
  ],
  ap_invoice_lines: [
    ...['ob-a', 'ob-a2', 'ob-b', 'ob-c', 'ob-d', 'ob-e', 'ob-f'].map((id) => line(id, '190-0000', 50000)),
    line('api-s1', '900-X001', 12000), line('api-s2', '900-X001', 3000),
    line('api-sd', '900-X004', 1000), line('api-sc', '900-X003', 1000),
    line('api-sx', '900-X004', 1000, OTHER_CO),
    line('api-h1', '900-X001', 7000), line('api-h2', '900-X002', 2000),
    line('api-r1', '900-X001', 5000), line('api-r2', '900-X003', 4000),
  ],
  acc_report_layouts: [{ report: 'rp', tree: TREE, updated_at: '2026-11-25T00:00:00Z', updated_by: 'test' }],
  acc_acquirers: [],
});

function harness() {
  const app = new Hono();
  const sb = world();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/accounting/reports/receipts-payments', receiptsPaymentsReport as never);
  return app;
}
type Row2 = { key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number; category?: string };
type Laid = { kind: string; id: string; key?: string; code?: string; label: string; amountSen: number; children: Laid[] };
type Report = {
  payments: Row2[];
  totals: { closing: Record<string, number> };
  entries: Array<{ jeNo: string; rowKey: string; party: string | null; sen: number }>;
  layout: { tree: Laid[]; outSen: number };
};
const get = async (): Promise<Report> => {
  const res = await harness().request('/accounting/reports/receipts-payments?from=2026-09-01&to=2026-09-30');
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
const row = (r: Report, key: string) => r.payments.find((x) => x.key === key);
const find = (nodes: Laid[], id: string): Laid | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children, id);
    if (hit) return hit;
  }
  return undefined;
};

describe('Cash Flow: a payment of an opening bill reads by its supplier\'s own bills (owner 2026-11-25)', () => {
  test('all of the supplier\'s live bills on one account: it reads as that account', async () => {
    const r = await get();
    /* PV-A's 500.00, and the 60.00 of PV-E's advance knocked off later. */
    expect(row(r, '900-X001')).toMatchObject({ code: '900-X001', name: 'STAND BUILD', cells: { [BANK]: 50000 + 6000 } });
    expect(r.entries.filter((e) => e.rowKey === '900-X001').map((e) => e.jeNo).sort()).toEqual(['JE-A', 'JE-E']);
    expect(row(r, '900-X004')).toBeUndefined();
    expect(row(r, '900-X003')).toBeUndefined();
  });

  test('several accounts in one Cash Flow category: a line of that category, with no code', async () => {
    const r = await get();
    expect(row(r, 'OPENING-BILLS:cf:exh')).toMatchObject({ code: null, name: 'Opening bills (AutoCount)', category: 'cf:exh', cells: { [BANK]: 30000 } });
    const exh = find(r.layout.tree, 'cf:exh')!;
    const lineNode = exh.children.at(-1)!;
    expect(lineNode).toMatchObject({ kind: 'account', key: 'OPENING-BILLS:cf:exh', label: 'Opening bills (AutoCount)', amountSen: 30000 });
    expect(lineNode.code).toBeUndefined();
    expect(exh.amountSen).toBe(56000 + 30000);
    expect(r.entries.filter((e) => e.rowKey === 'OPENING-BILLS:cf:exh').map((e) => e.party)).toEqual(['FAIRHALL']);
  });

  test('spread over two categories, or no bill in the ERP, or still ahead of any bill: the creditor control', async () => {
    const r = await get();
    /* PV-C (stand + lorry), PV-D (no bill), and the 20.00 of PV-E not yet knocked off. */
    expect(row(r, '400-0000')?.cells).toEqual({ [BANK]: 20000 + 10000 + 2000 });
    expect(r.entries.filter((e) => e.rowKey === '400-0000').map((e) => e.jeNo).sort()).toEqual(['JE-C', 'JE-D', 'JE-E']);
    expect(row(r, '190-0000')).toBeUndefined();
  });

  test('paid out of the trade-finance account it stays TF-AP; every bank still moves by exactly what it paid', async () => {
    const r = await get();
    expect(row(r, TRADE_FINANCE_AP)?.cells).toEqual({ [TF_BANK]: 4000 });
    expect(r.totals.closing).toEqual({ [BANK]: 500000 - 50000 - 30000 - 20000 - 10000 - 8000, [TF_BANK]: 100000 - 4000 });
    expect(r.layout.outSen).toBe(50000 + 30000 + 20000 + 10000 + 8000 + 4000);
    expect(find(r.layout.tree, 'unassigned:out')).toBeUndefined();
  });

  test('the rule on its own: one account, one category, else null (spread, one not placed, none)', () => {
    const homes = new Map([['900-X001', { id: 'cf:exh', label: 'EXHIBITION' }], ['900-X002', { id: 'cf:exh', label: 'EXHIBITION' }], ['900-X003', { id: 'cf:exh:lorry', label: 'TRANSPORT' }]]);
    const a = (code: string) => ({ code, name: code });
    expect(openingBillHome([a('900-X009')], homes)).toEqual({ kind: 'account', code: '900-X009', name: '900-X009' });
    expect(openingBillHome([a('900-X001'), a('900-X002')], homes)).toEqual({ kind: 'category', id: 'cf:exh', label: 'EXHIBITION' });
    expect(openingBillHome([a('900-X001'), a('900-X003')], homes)).toBeNull();
    expect(openingBillHome([a('900-X001'), a('900-X009')], homes)).toBeNull();
    expect(openingBillHome([], homes)).toBeNull();
  });
});
