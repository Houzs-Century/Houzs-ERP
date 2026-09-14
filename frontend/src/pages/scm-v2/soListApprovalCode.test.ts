/* The Sales Order list's Approval Code column (owner 2026-09-15,
   docs/bugs/0909: 我要的就是这个 payment 的 approval code). A source contract,
   like searchScopeContracts.test.ts: the column reads the server's
   per-payment summary — never the header's legacy approval_code — sits with
   the money columns, and the search hint promises the code only because the
   server now searches it (tests/soListApprovalCode.test.ts pins that end).
   The column lives in its own module because the list file may only shrink. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = (relative: string) => readFileSync(resolve(process.cwd(), 'src', relative), 'utf8');
const list = source('pages/scm-v2/MfgSalesOrdersListV2.tsx');
const column = source('pages/scm-v2/so-list-approval-code.tsx');

describe('the Approval Code column', () => {
  test('the sources loaded', () => {
    expect(list.length).toBeGreaterThan(1000);
    expect(column.length).toBeGreaterThan(300);
  });

  test('reads the per-payment summary the server sends, never the header\'s legacy field', () => {
    expect(column).toContain('key: "approval_codes"');
    expect(column).toContain('label: "Approval Code"');
    expect(column).toContain('approval_codes_summary');
    expect(column).not.toMatch(/\.approval_code\b/);
  });

  test('is hidden by default like Payment Method, and follows it in the list', () => {
    expect(column).toContain('defaultHidden: true');
    const payment = list.indexOf('key: "payment_method"');
    const placed = list.indexOf('approvalCodeColumn,');
    const paid = list.indexOf('key: "paid"');
    expect(payment).toBeGreaterThan(-1);
    expect(placed).toBeGreaterThan(payment);
    expect(paid).toBeGreaterThan(placed);
    expect(list).toContain('import { approvalCodeColumn } from "./so-list-approval-code";');
  });

  test('the search hint promises the code, on every search box of the page', () => {
    const hints = list.match(/placeholder[=:] ?"Search [^"]*"/g) ?? [];
    expect(hints.length).toBeGreaterThanOrEqual(3);
    for (const hint of hints) expect(hint).toContain('approval code');
  });
});
