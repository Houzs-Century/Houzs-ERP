import { describe, expect, it } from 'vitest';
import { NAV_TABS, type NavTab } from './Sidebar';
import { ACCOUNTING_TABS } from '../pages/scm-v2/accounting-tabs';

/**
 * THE FINANCE SIDEBAR IS GROUPED BY THE JOB, NOT A FLAT LIST (docs/bugs/0824).
 *
 * Owner, 2026-09-12: finance 的 function 分到很散 … maintenance 的东西一个子
 * side bar, report 一个 side bar. Fifteen flat entries plus thirteen tabs on
 * the Accounting page became six groups: Money in, Money out, Bank & cards,
 * Books, Reports, Setup. The Accounting page's tabs are reached by deep link
 * (`/scm/accounting?tab=…`), so the sidebar can name a report directly.
 *
 * Pinned here: the six groups in the owner's order; every destination that
 * existed before still exists (nothing lost in the move); every deep link
 * names a tab the page knows; no destination twice.
 */
const flatten = (tabs: readonly NavTab[]): NavTab[] =>
  tabs.flatMap((t) => [t, ...(t.children ? flatten(t.children) : [])]);

const finance = NAV_TABS.find((t) => t.groupId === 'scm-finance');

describe('the Finance sidebar', () => {
  it('is six groups, in the order the money moves', () => {
    expect(finance).toBeDefined();
    expect((finance?.children ?? []).map((g) => g.label)).toEqual([
      'Money in', 'Money out', 'Bank & cards', 'Books', 'Reports', 'Setup',
    ]);
    for (const g of finance?.children ?? []) {
      expect(g.children?.length ?? 0, `${g.label} has entries`).toBeGreaterThan(0);
      expect(g.groupId, `${g.label} remembers its open state`).toBeTruthy();
      expect(g.to, `${g.label} is a group header, not a link`).toBeUndefined();
    }
  });

  it('keeps every destination the flat list had', () => {
    const tos = flatten(finance?.children ?? []).map((t) => t.to).filter((t): t is string => typeof t === 'string');
    for (const to of [
      '/scm/daily-bank', '/scm/merchant-recon', '/scm/official-receipts', '/scm/bank-recon',
      '/scm/settlement-setup', '/scm/chart-of-accounts', '/scm/other-debtors', '/scm/ap-invoices',
      '/scm/receipts', '/scm/payment-vouchers', '/scm/outstanding', '/scm/unbilled-deliveries',
      '/scm/currencies', '/reports/fair-report',
    ]) expect(tos, `${to} is still reachable`).toContain(to);
    /* The Accounting page's tabs, now reachable by name. */
    for (const tab of ['je', 'gl', 'tb', 'close', 'check', 'pnl', 'bs', 'rp', 'ar', 'ap', 'corrections', 'collection', 'groups']) {
      expect(tos, `tab ${tab} is deep-linked`).toContain(`/scm/accounting?tab=${tab}`);
    }
    expect(new Set(tos).size, 'no destination twice').toBe(tos.length);
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

  it('puts the reports together, the Corrections report among them', () => {
    const reports = finance?.children?.find((g) => g.label === 'Reports');
    const labels = (reports?.children ?? []).map((t) => t.label);
    expect(labels).toEqual(expect.arrayContaining(['P&L', 'Balance Sheet', 'Receipts & Payments', 'AR Aging', 'AP Aging', 'Corrections', 'Sales Report']));
  });
});
