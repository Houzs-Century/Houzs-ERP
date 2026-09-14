/* The Sales Order list's Approval Code column (owner 2026-09-15,
   docs/bugs/0909: 我要的就是这个 payment 的 approval code). A source contract,
   like searchScopeContracts.test.ts: the column reads the server's
   per-payment summary — never the header's legacy approval_code — sits with
   the money columns, and the search hint promises the code only because the
   server now searches it (tests/soListApprovalCode.test.ts pins that end). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/scm-v2/MfgSalesOrdersListV2.tsx'), 'utf8');

describe('the Approval Code column', () => {
  test('the source loaded', () => {
    expect(source.length).toBeGreaterThan(1000);
  });

  test('is a column of its own, reading the per-payment summary the server sends', () => {
    const start = source.indexOf('key: "approval_codes"');
    expect(start).toBeGreaterThan(-1);
    const column = source.slice(start, source.indexOf('key: "paid"', start));
    expect(column).toContain('label: "Approval Code"');
    expect(column).toContain('r.approval_codes_summary');
    expect(column, 'the header\'s legacy approval_code is not the payment\'s').not.toContain('r.approval_code ');
  });

  test('follows the Payment Method column, and is hidden by default like it', () => {
    const payment = source.indexOf('key: "payment_method"');
    const codes = source.indexOf('key: "approval_codes"');
    expect(payment).toBeGreaterThan(-1);
    expect(codes).toBeGreaterThan(payment);
    const column = source.slice(codes, source.indexOf('key: "paid"', codes));
    expect(column).toContain('defaultHidden: true');
  });

  test('the quick view shows it too', () => {
    expect(source).toMatch(/k="Approval code"\s+v=\{row\.approval_codes_summary \|\| "—"\}/);
  });

  test('the search hint promises the code, on every search box of the page', () => {
    const hints = source.match(/placeholder[=:] ?"Search [^"]*"/g) ?? [];
    expect(hints.length).toBeGreaterThanOrEqual(3);
    for (const hint of hints) expect(hint).toContain('approval code');
  });
});
