import { describe, expect, it } from 'vitest';
import { NAV_TABS, type NavTab } from './Sidebar';
import { ACCOUNTING_TABS } from '../pages/scm-v2/accounting-tabs';
import { STAFF_LEGACY_REDIRECT_PATTERNS } from '../routing/routeManifest';

/**
 * THE FINANCE SIDEBAR IS GROUPED BY THE JOB, NOT A FLAT LIST (docs/bugs/0824).
 *
 * Owner, 2026-09-12: finance 的 function 分到很散 … maintenance 的东西一个子
 * side bar, report 一个 side bar. Fifteen flat entries plus thirteen tabs on
 * the Accounting page became six groups: Money in, Money out, Bank & cards,
 * Books, Reports, Setup. The Accounting page's tabs are reached by deep link
 * (`/scm/accounting?tab=…`), so the sidebar can name a report directly.
 * A seventh, Forecasting, joined on 2026-09-21 (the Forecast P&L; the
 * Dashboard follows) — targets, not books, so it sat after the reports.
 *
 * The owner's Claude Design redesign (2026-11-02) puts two single entries
 * above them: To do (Finance's home, with its count) and Money today; and
 * Reports becomes ONE entry with its own report list (batch 6 §1.1) — the old
 * Reports and Forecasting entries its hidden members (sidebarReportsEntry.test).
 *
 * Pinned here: the two entries, then the six groups in the owner's order;
 * every destination that existed before still exists (nothing lost in the
 * move); every deep link names a tab the page knows; no destination twice.
 */
const flatten = (tabs: readonly NavTab[]): NavTab[] =>
  tabs.flatMap((t) => [t, ...(t.children ? flatten(t.children) : [])]);

const finance = NAV_TABS.find((t) => t.groupId === 'scm-finance');

const groups = (finance?.children ?? []).filter((g) => g.children);

describe('the Finance sidebar', () => {
  it('opens with To do and Money today, single entries with their own page', () => {
    const [todo, money] = finance?.children ?? [];
    expect(todo).toMatchObject({ label: 'To do', to: '/scm/finance', end: true, badge: 'finance-todo' });
    expect(money).toMatchObject({ label: 'Money today', to: '/scm/daily-bank?view=board' });
    expect(todo.children, 'To do is a page, not a group').toBeUndefined();
    expect(money.children, 'Money today is a page, not a group').toBeUndefined();
  });

  it('is six groups, in the order the money moves', () => {
    expect(finance).toBeDefined();
    expect((finance?.children ?? []).map((g) => g.label)).toEqual([
      'To do', 'Money today',
      'Money in', 'Money out', 'Bank & cards', 'Books', 'Reports', 'Setup',
    ]);
    expect(groups).toHaveLength(6);
    for (const g of groups) {
      expect(g.children?.length ?? 0, `${g.label} has entries`).toBeGreaterThan(0);
      expect(g.groupId, `${g.label} remembers its open state`).toBeTruthy();
      expect(g.to, `${g.label} is a group header, not a link`).toBeUndefined();
    }
  });

  it('keeps every destination the flat list had', () => {
    const tos = flatten(finance?.children ?? []).map((t) => t.to).filter((t): t is string => typeof t === 'string');
    for (const to of [
      '/scm/daily-bank', '/scm/merchant-recon', '/scm/bank-recon',
      '/scm/settlement-setup', '/scm/chart-of-accounts', '/scm/other-debtors', '/scm/ap-invoices',
      '/scm/receipts', '/scm/payment-vouchers', '/scm/outstanding', '/scm/unbilled-deliveries',
      '/scm/currencies', '/reports/fair-report',
      /* And the ones added since (docs/bugs/0827, 0828; the Forecast P&L 2026-09-21). */
      '/scm/credit-notes', '/scm/forecast', '/scm/finance-dashboard',
      '/scm/ar-invoices',
      '/scm/unmatched-payments',
      '/scm/supplier-notes',
      '/scm/daily-bank-cashbook',
    ]) expect(tos, `${to} is still reachable`).toContain(to);
    for (const tab of ['je', 'gl', 'tb', 'close', 'check', 'pnl', 'bs', 'rp', 'ar', 'ap', 'corrections', 'collection', 'charges', 'groups', 'products', 'logistics', 'departments', 'changesum']) {
      expect(tos, `tab ${tab} is deep-linked`).toContain(`/scm/accounting?tab=${tab}`);
    }
    /* The Overall P&L's Performance view is gone (owner 2026-11-28); its old links land on Actual. */
    expect(tos).not.toContain('/scm/accounting?tab=performance');
    expect(new Set(tos).size, 'no destination twice').toBe(tos.length);
  });

  it('folds Official receipts into Receipts: one entry, the old address a redirect', () => {
    const moneyIn = finance?.children?.find((g) => g.label === 'Money in')?.children ?? [];
    expect(moneyIn[0]).toMatchObject({ to: '/scm/receipts', label: 'Receipts', anyAccess: ['scm.finance.money_in'] });
    expect(moneyIn[0]?.anyPerm).toEqual(expect.arrayContaining(['*', 'scm.access', 'scm.payment_voucher.create', 'scm.payment_voucher.post', 'scm.sales_order.write']));
    expect(moneyIn.some((t) => t.to === '/scm/official-receipts')).toBe(false);
    expect(STAFF_LEGACY_REDIRECT_PATTERNS as readonly string[]).toContain('/scm/official-receipts');
  });

  it('folds Deposit invoices into Invoices, and puts their switch in Setup', () => {
    const moneyIn = finance?.children?.find((g) => g.label === 'Money in')?.children ?? [];
    expect(moneyIn.map((t) => t.label)).toEqual(['Receipts', 'Invoices', 'Debtor maintenance', 'Credit / debit notes', 'Outstanding', 'Not yet billed']);
    const invoices = moneyIn.find((t) => t.to === '/scm/ar-invoices');
    expect(invoices?.anyPerm).toEqual(expect.arrayContaining(['*', 'scm.access', 'scm.payment_voucher.create', 'scm.payment_voucher.post', 'scm.sales_order.write']));
    expect(moneyIn.some((t) => t.to === '/scm/deposit-invoices')).toBe(false);
    expect(STAFF_LEGACY_REDIRECT_PATTERNS as readonly string[]).toContain('/scm/deposit-invoices');
    const setup = finance?.children?.find((g) => g.label === 'Setup')?.children ?? [];
    const labels = setup.map((t) => t.label);
    expect(labels.indexOf('Deposit invoices')).toBe(labels.indexOf('Currencies') + 1);
    expect(labels.indexOf('To do rules')).toBe(labels.indexOf('Deposit invoices') + 1);
    expect(setup.find((t) => t.label === 'Deposit invoices')).toMatchObject({
      to: '/scm/finance/deposit-invoices', anyPerm: ['*', 'scm.access', 'scm.payment_voucher.post', 'scm.sales_order.write'], anyAccess: ['scm.finance.money_in'],
    });
  });

  it('deep-links only tabs the Accounting page knows', () => {
    const deep = flatten(finance?.children ?? [])
      .map((t) => t.to)
      .filter((t): t is string => typeof t === 'string' && t.startsWith('/scm/accounting?tab='));
    expect(deep.length).toBeGreaterThan(0);
    for (const to of deep) {
      const tab = new URLSearchParams(to.split('?')[1]).get('tab') ?? '';
      expect(ACCOUNTING_TABS as readonly string[], `${to} names a real tab`).toContain(tab);
    }
  });

  /* Owner 2026-10-28: supplier & other creditor CN / DN 和 customer & other debtor
     CN / DN 分出来 — each beside the money it moves. */
  it('splits the notes: the customer\'s and other debtor\'s under Money in, the supplier\'s under Money out', () => {
    const entries = (label: string) => flatten(finance?.children?.find((g) => g.label === label)?.children ?? []);
    expect(entries('Money in').find((t) => t.to === '/scm/credit-notes')?.label).toBe('Credit / debit notes');
    expect(entries('Money in').find((t) => t.to === '/scm/credit-notes')?.anyAccess).toEqual(['scm.finance.money_in']);
    expect(entries('Money out').find((t) => t.to === '/scm/supplier-notes')?.label).toBe('Supplier & other creditor CN / DN');
    expect(entries('Money out').find((t) => t.to === '/scm/supplier-notes')?.anyAccess).toEqual(['scm.finance.money_out']);
  });

  it('names the Money-in pages as the redesign does', () => {
    const moneyIn = finance?.children?.find((g) => g.label === 'Money in')?.children ?? [];
    const byTo = (to: string) => moneyIn.find((t) => t.to === to);
    expect(byTo('/scm/other-debtors')).toMatchObject({ label: 'Debtor maintenance', anyAccess: ['scm.finance.money_in'] });
    expect(byTo('/scm/unbilled-deliveries')).toMatchObject({ label: 'Not yet billed', anyAccess: ['scm.finance.outstanding'] });
    expect(byTo('/scm/credit-notes')?.label).toBe('Credit / debit notes');
    expect(byTo('/scm/receipts')?.label).toBe('Receipts');
    expect(byTo('/scm/outstanding')?.label).toBe('Outstanding');
  });

  it('puts the reports together — the Corrections report, the Forecast P&L and the Dashboard among them', () => {
    const reports = finance?.children?.find((g) => g.label === 'Reports');
    expect(reports?.collapsed, 'one entry with its own report list').toBe(true);
    const labels = (reports?.children ?? []).map((t) => t.label);
    expect(labels).toEqual(expect.arrayContaining([
      'P&L', 'Balance sheet', 'Cash flow', 'AR aging', 'AP aging', 'Corrections', 'Sales report · fairs', 'Product profit',
      'Forecast P&L', 'Dashboard',
    ]));
  });

  it('names Books and Setup as the redesign does', () => {
    const entries = (label: string) => finance?.children?.find((g) => g.label === label)?.children ?? [];
    expect(entries('Books').map((t) => [t.label, t.to])).toEqual([
      ['Journal entries', '/scm/accounting?tab=je'],
      ['General ledger', '/scm/accounting?tab=gl'],
      ['Trial balance', '/scm/accounting?tab=tb'],
      ['Self-check', '/scm/accounting?tab=check'],
      ['Stock close', '/scm/accounting?tab=close'],
      ['Commission release', '/scm/accounting?tab=commrel'],
    ]);
    for (const t of entries('Books')) expect(t, t.label).toMatchObject({ anyPerm: ['*', 'scm.access'], anyAccess: ['scm.finance.books'] });
    expect(entries('Setup').map((t) => t.label)).toEqual([
      'Chart of accounts', 'Opening balance', 'Item groups', 'Recon setup', 'Currencies', 'Deposit invoices', 'To do rules',
    ]);
  });
});
