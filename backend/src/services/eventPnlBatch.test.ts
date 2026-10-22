import { describe, expect, it } from 'vitest';
import type { Env } from '../types';
import { pnlForProjects, withPnlColumns } from './eventPnlBatch';

/* The Projects list reads the event page's P&L for a page of events at once
 * (owner 2026-10-19, ledger item 5): Finance's books, the orders and the rate
 * card, not the typed lines alone. A failed read leaves the list's own figures. */

type Row = Record<string, unknown>;
function env(answers: Array<[RegExp, Row[] | Error]>): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => {
            const hit = answers.find(([re]) => re.test(sql));
            const a = hit ? hit[1] : [];
            if (a instanceof Error) throw a;
            return { results: a };
          },
        }),
      }),
    },
  } as unknown as Env;
}

const LEDGER = /FROM project_finance_lines/;
const SALES = /FROM sales_entries/;
const GL = /FROM scm\.journal_entry_lines/;
const SO = /FROM scm\.mfg_sales_orders/;
const RATES = /FROM project_cost_rates/;

const leg = (project_id: number, o: Row = {}): Row => ({
  project_id, leg_id: `l${project_id}`, account_code: '900-R032', debit_sen: 800000, credit_sen: 0, notes: null,
  je_no: 'JE-1', entry_date: '2026-10-05', source_type: 'PV', source_doc_no: 'PV-1', posted: true, reversed: false,
  reversed_by_je: null, account_name: 'RENTAL - EXHIBITION', account_type: 'EXPENSE', pms_row: 'rental', ...o,
});

describe('pnlForProjects — a page of events, the event page\'s figures', () => {
  it('each event gets its own P&L: Finance\'s rental replaces the typed one; the box and the orders drive the rest', async () => {
    const e = env([
      [LEDGER, [{ project_id: 1, id: 10, kind: 'cost', category: 'rental', amount: 9500 }, { project_id: 2, id: 20, kind: 'cost', category: 'setup', amount: 3000 }]],
      [SALES, [{ project_id: 2, amount: 40000 }]],
      [GL, [leg(1)]],
      [SO, [{ project_id: 1, local_total_sen: 4635200, total_revenue_sen: 0, mattress_sofa_cost_sen: 1500000, bedframe_cost_sen: 0, accessories_cost_sen: 278000, others_cost_sen: 0 }]],
      [RATES, [{ brand: 'ZANOTTI', transport_pct: 5, merchandise_pct: 2, commission_normal_pct: 13, commission_boost_pct: null, boost_min_gp_pct: null, boost_min_sales: null }]],
    ]);
    const pnl = await pnlForProjects(e, [{ id: 1, brand: 'ZANOTTI', total_sales: 114240 }, { id: 2, brand: 'NOCARD', total_sales: null }], 1, ['rental', 'setup']);
    const one = pnl.get(1)!.by_sales;
    expect(one.rental).toBe(8000);
    expect(one).toMatchObject({ sales: 114240, salesFrom: 'box' });
    expect(one.cogs.from).toBe('so_ratio');
    expect(one.transportFee).toMatchObject({ from: 'rate', amount: 5712 });
    expect(pnl.get(1)!.by_so).toMatchObject({ sales: 46352 });
    const two = pnl.get(2)!.by_sales;
    expect(two).toMatchObject({ sales: 40000, salesFrom: 'lines', setup: 3000 });
    expect(two.commission.from).toBe('none');
    expect(pnl.get(2)!.by_so).toBeNull();
  });

  it('a voucher Finance has CHECKED counts on the list too, as on the event page', async () => {
    const e = env([
      [/FROM scm\.payment_voucher_lines/, [leg(3, { leg_id: 'pv3', source_type: 'PV_CHECKED', je_no: 'PV-2610-009', source_doc_no: 'PV-2610-009', debit_sen: 500000 })]],
      [LEDGER, [{ project_id: 3, id: 30, kind: 'cost', category: 'rental', amount: 9500 }]],
    ]);
    const pnl = await pnlForProjects(e, [{ id: 3, total_sales: 20000 }], 1, ['rental']);
    expect(pnl.get(3)!.by_sales.rental).toBe(5000);
  });

  it('a failed read leaves the list\'s own figures (an empty map)', async () => {
    expect((await pnlForProjects(env([[SO, new Error('down')]]), [{ id: 1, total_sales: 5 }], 1, [])).size).toBe(0);
    expect((await pnlForProjects(env([[GL, new Error('down')]]), [{ id: 1, total_sales: 5 }], 1, [])).size).toBe(0);
  });
});

describe('withPnlColumns — the list\'s finance columns read the P&L', () => {
  it('overwrites the Rental and ledger columns of the rows it covers, and only those', async () => {
    const e = env([[LEDGER, [{ project_id: 1, id: 10, kind: 'cost', category: 'rental', amount: 9500 }]]]);
    const pnl = await pnlForProjects(e, [{ id: 1, total_sales: 1000 }], 1, ['rental']);
    const rows = withPnlColumns([{ id: 1, rental: 1, fin_revenue: 0, fin_total_cost: 0 }, { id: 2, rental: 7 }], pnl);
    expect(rows[0]).toMatchObject({ rental: 9500, fin_revenue: 1000, fin_rental: 9500, fin_total_cost: 9500 });
    expect(rows[1]).toEqual({ id: 2, rental: 7 });
  });
});
