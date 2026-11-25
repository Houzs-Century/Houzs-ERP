/* A payment of an opening bill reads by what the bill bought, from AutoCount's
   own lines (owner 2026-11-25, 「如果系统可以分得出purchase of sofa 和purchase
   of bedding 更加好」): each product group with a purchase account on that
   account, in proportion, as a purchase invoice reads; the rest of the bill as
   its supplier's line; a bill's own choice still takes it whole; paid out of a
   trade-finance bank it stays TF-AP. The settings doors show it. Real
   handlers, fake PostgREST; every name and figure is made up. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { goodsParts } from '../src/acc/opening-bill-places';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';
import { openingBillsGet, openingBillsOfSupplier } from '../src/scm/routes/accounting-opening-bill-places';

const CO = 2;
const OTHER_CO = 3;
const BANK = '310-0010';
const TF_BANK = '310-0060';
let n = 0;
const acct = (code: string, name: string, extra: Row = {}): Row =>
  ({ company_id: CO, account_code: code, account_name: name, acc_money: false, is_active: true, account_type: 'EXPENSE', section: 'EXPENSES', ...extra });
const bill = (id: string, supplier: string, total: number, paid: number, company = CO): Row =>
  ({ id, company_id: company, invoice_number: id.toUpperCase(), invoice_date: '2026-08-31', supplier_id: supplier, status: paid >= total ? 'PAID' : 'POSTED', total_sen: total, paid_sen: paid, opening: true, notes: `OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT PI-${id} — MADE-UP TEXT` });
const pay = (je: string, pv: string, party: string, sen: number, bank = BANK): Row[] => [
  { line_id: ++n, company_id: CO, je_no: je, entry_date: '2026-09-10', source_type: 'PV', source_doc_no: pv, account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', debit_sen: sen, credit_sen: 0, party_type: 'SUPPLIER', party_name: party, notes: null, posted: true, reversed: false },
  { line_id: ++n, company_id: CO, je_no: je, entry_date: '2026-09-10', source_type: 'PV', source_doc_no: pv, account_code: bank, account_name: bank === BANK ? 'CASH AT BANK' : 'CASH AT BANK (TRADE FINANCE)', debit_sen: 0, credit_sen: sen, party_type: null, party_name: null, notes: null, posted: true, reversed: false },
];
const alloc = (pv: string, invoice: string, sen: number): Row => ({ id: `al-${++n}`, company_id: CO, pv_id: pv, pi_id: null, ap_invoice_id: invoice, amount_sen: sen, applied_sen: sen, from_advance: false });
const goods = (bill: string, group: string, sen: number, company = CO): Row => ({ company_id: company, ap_invoice_id: bill, group_code: group, myr_sen: sen, ac_doc_no: `PI-${bill}` });
const net = (code: string) => ({ kind: 'account', code, flow: 'net' });

const TREE = {
  version: 1,
  blocks: {
    accounts: [{
      kind: 'category', id: 'cf:out', label: 'OUTFLOWS', flow: 'out', children: [
        { kind: 'category', id: 'cf:buy', label: 'PURCHASES', children: [net('601-0001'), net('601-0003'), net('602-0000'), { kind: 'category', id: 'cf:ap', label: 'CREDITORS', children: [net('400-0000')] }] },
        { kind: 'category', id: 'cf:exh', label: 'EXHIBITION', children: [net('900-X001'), net('900-X002')] },
        { kind: 'category', id: 'cf:tf', label: 'TRADE FINANCE AP', children: [net('TF-AP')] },
      ],
    }],
  },
};

const tables = (): Record<string, Row[]> => ({
  accounts: [
    acct(BANK, 'CASH AT BANK', { acc_money: true, account_type: 'ASSET', section: 'CURRENT ASSETS' }),
    acct(TF_BANK, 'CASH AT BANK (TRADE FINANCE)', { acc_money: true, account_type: 'ASSET', section: 'CURRENT ASSETS' }),
    acct('400-0000', 'ACCOUNT PAYABLE', { account_type: 'LIABILITY', section: 'CURRENT LIABILITIES' }),
    acct('190-0000', 'OPENING BALANCE CLEARING', { account_type: 'EQUITY', section: 'EQUITY' }),
    acct('601-0001', 'PURCHASE OF BEDDING', { section: 'COST OF GOODS SOLD' }),
    acct('601-0003', 'PURCHASE OF SOFA', { section: 'COST OF GOODS SOLD' }),
    acct('602-0000', 'PURCHASE OF ACCESSORIES', { section: 'COST OF GOODS SOLD' }),
    acct('900-X001', 'STAND BUILD'), acct('900-X002', 'HALL RENTAL'),
  ],
  acc_item_group_accounts: [
    { company_id: CO, group_code: 'BEDFRAME', purchase_account: '601-0001' },
    { company_id: CO, group_code: 'MATTRESS', purchase_account: '601-0001' },
    { company_id: CO, group_code: 'SOFA', purchase_account: '601-0003' },
    { company_id: CO, group_code: 'ACCESSORY', purchase_account: '602-0000' },
    { company_id: OTHER_CO, group_code: 'TRANSPORT', purchase_account: '601-0001' },
  ],
  suppliers: ['H', 'K', 'M', 'N', 'T'].map((x) => ({ id: `sup-${x}`, company_id: CO, code: `${x}001`, name: `SUPPLIER ${x}` })),
  ap_invoices: [
    bill('ob-h1', 'sup-H', 10000, 5000), bill('ob-h2', 'sup-H', 3000, 0),
    bill('ob-k1', 'sup-K', 2000, 2000),
    bill('ob-m1', 'sup-M', 1000, 1000),
    bill('ob-n1', 'sup-N', 4000, 4000),
    bill('ob-t1', 'sup-T', 6000, 6000),
  ],
  ap_invoice_lines: ['ob-h1', 'ob-h2', 'ob-k1', 'ob-m1', 'ob-n1', 'ob-t1'].map((id) => ({ id: `l-${id}`, company_id: CO, invoice_id: id, debit_account_code: '190-0000', amount_sen: 100 })),
  acc_opening_bill_goods: [
    /* H: bed frames and a mattress (one account) and a sofa. */
    goods('ob-h1', 'BEDFRAME', 5200), goods('ob-h1', 'MATTRESS', 3000), goods('ob-h1', 'SOFA', 1800),
    /* K: a sofa — but Finance chose this bill's line itself. */
    goods('ob-k1', 'SOFA', 2000),
    /* M: a sofa, a delivery charge in a group with no purchase account, and a line with no group. */
    goods('ob-m1', 'SOFA', 600), goods('ob-m1', 'TRANSPORT', 300), goods('ob-m1', '', 100),
    /* N: only another company's row — not this bill's goods. */
    goods('ob-n1', 'SOFA', 4000, OTHER_CO),
    /* T: a sofa, paid out of the trade-finance bank. */
    goods('ob-t1', 'SOFA', 6000),
  ],
  acc_opening_supplier_places: [
    { company_id: CO, supplier_id: 'sup-H', account_code: '601-0001', category_id: null },
    { company_id: CO, supplier_id: 'sup-M', account_code: '900-X002', category_id: null },
    { company_id: CO, supplier_id: 'sup-N', account_code: '900-X002', category_id: null },
  ],
  acc_opening_bill_places: [{ company_id: CO, ap_invoice_id: 'ob-k1', account_code: '900-X001', category_id: null }],
  v_gl_entries: [
    ...pay('JE-H', 'PV-H', 'SUPPLIER H', 5000), ...pay('JE-K', 'PV-K', 'SUPPLIER K', 2000), ...pay('JE-M', 'PV-M', 'SUPPLIER M', 1000),
    ...pay('JE-N', 'PV-N', 'SUPPLIER N', 4000), ...pay('JE-T', 'PV-T', 'SUPPLIER T', 6000, TF_BANK),
  ],
  payment_vouchers: ['H', 'K', 'M', 'N', 'T'].map((x) => ({ id: `pv-${x}`, company_id: CO, pv_number: `PV-${x}`, status: 'POSTED' })),
  pv_allocations: [alloc('pv-H', 'ob-h1', 5000), alloc('pv-K', 'ob-k1', 2000), alloc('pv-M', 'ob-m1', 1000), alloc('pv-N', 'ob-n1', 4000), alloc('pv-T', 'ob-t1', 6000)],
  purchase_invoices: [],
  acc_account_roles: [],
  acc_acquirers: [],
  acc_report_layouts: [{ report: 'rp', tree: TREE, updated_at: '2026-11-25T00:00:00Z', updated_by: 'test' }],
});

function harness(t = tables()) {
  const app = new Hono();
  const sb = fakeSb(t);
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/rp', receiptsPaymentsReport as never);
  app.get('/ob', openingBillsGet as never);
  app.get('/ob/:supplierId', openingBillsOfSupplier as never);
  return app;
}

type Payments = { payments: Array<{ key: string; code: string | null; cells: Record<string, number> }> };

describe('Cash Flow: an opening bill reads by what it bought (owner 2026-11-25)', () => {
  test('sofa and bedding apart, in the bill\'s own proportion; the rest as its supplier\'s line; a bill\'s own choice whole; trade finance stays TF-AP', async () => {
    const res = await harness().request('/rp?from=2026-09-01&to=2026-09-30');
    expect(res.status, await res.clone().text()).toBe(200);
    const r = await res.json() as Payments;
    const cells = (key: string) => r.payments.find((p) => p.key === key)?.cells;
    /* H paid 5,000 of a bill of bedding 8,200 · sofa 1,800 → 4,100 · 900; its supplier's bedding line takes nothing more.
       M paid 1,000 of sofa 600 · rest 400 → 600 on sofa, 400 on its supplier's line. */
    expect(cells('601-0001')).toEqual({ [BANK]: 4100 });
    expect(cells('601-0003')).toEqual({ [BANK]: 900 + 600 });
    expect(cells('900-X002')).toEqual({ [BANK]: 400 + 4000 }); // M's rest, and N (another company's goods row is not its goods)
    expect(cells('900-X001')).toEqual({ [BANK]: 2000 });       // K: the bill's own choice, whole
    expect(cells('TF-AP')).toEqual({ [TF_BANK]: 6000 });       // T: paid from the trade-finance bank
    expect(cells('400-0000')).toBeUndefined();
  });

  test('the settings doors: how many bills read by what they bought, and each bill\'s split', async () => {
    const app = harness();
    const list = await (await app.request('/ob')).json() as { suppliers: Array<{ code: string; billsByGoods: number; billsSet: number }> };
    const of = (code: string) => list.suppliers.find((s) => s.code === code);
    expect(of('H001')).toMatchObject({ billsByGoods: 1, billsSet: 0 });
    expect(of('K001')).toMatchObject({ billsByGoods: 0, billsSet: 1 });
    expect(of('M001')).toMatchObject({ billsByGoods: 1 });
    expect(of('N001')).toMatchObject({ billsByGoods: 0 });

    const h = await (await app.request('/ob/sup-H')).json() as { bills: Array<{ id: string; goods: unknown }> };
    expect(h.bills.find((b) => b.id === 'ob-h1')?.goods).toEqual({
      parts: [{ code: '601-0001', name: 'PURCHASE OF BEDDING', sen: 8200 }, { code: '601-0003', name: 'PURCHASE OF SOFA', sen: 1800 }], restSen: 0,
    });
    expect(h.bills.find((b) => b.id === 'ob-h2')?.goods).toBeNull();
    const m = await (await app.request('/ob/sup-M')).json() as { bills: Array<{ goods: unknown }> };
    expect(m.bills[0]!.goods).toEqual({ parts: [{ code: '601-0003', name: 'PURCHASE OF SOFA', sen: 600 }], restSen: 400 });
  });

  test('the split: groups sharing an account are one part; a group with no account and lines with no group are the rest; nothing with an account, no split', () => {
    const accountOf = new Map([['BEDFRAME', '601-0001'], ['MATTRESS', '601-0001'], ['SOFA', '601-0003']]);
    expect(goodsParts(new Map([['BEDFRAME', 50], ['MATTRESS', 30], ['sofa', 20]]), accountOf))
      .toEqual({ parts: [{ code: '601-0001', sen: 80 }, { code: '601-0003', sen: 20 }], restSen: 0 });
    expect(goodsParts(new Map([['SOFA', 70], ['TRANSPORT', 20], ['', 10]]), accountOf)).toEqual({ parts: [{ code: '601-0003', sen: 70 }], restSen: 30 });
    /* A discount line with no group spreads over the goods; a returned group drops out. */
    expect(goodsParts(new Map([['SOFA', 100], ['', -10], ['BEDFRAME', -5]]), accountOf)).toEqual({ parts: [{ code: '601-0003', sen: 100 }], restSen: 0 });
    expect(goodsParts(new Map([['TRANSPORT', 100]]), accountOf)).toBeNull();
    expect(goodsParts(undefined, accountOf)).toBeNull();
  });
});
