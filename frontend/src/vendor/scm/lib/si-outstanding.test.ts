import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { siCreditNotesSen, siDepositAppliedSen, siSettledSen, siOutstandingSen } from './si-outstanding';

describe('the rule', () => {
  test('the order deposit settles the invoice alongside its own receipts', () => {
    expect(siOutstandingSen(440_000, 0, 200_000, 0)).toBe(240_000);
    expect(siSettledSen(0, 200_000, 0)).toBe(200_000);
  });

  test('the two kinds of money add up rather than replacing one another', () => {
    expect(siOutstandingSen(440_000, 100_000, 200_000, 0)).toBe(140_000);
  });

  /* A customer's credit note knocked off it (owner 2026-11-03: 「要」) settles
     it a third way — beside the receipts and the deposit, never inside them. */
  test('the credit notes knocked off it come off too', () => {
    expect(siOutstandingSen(440_000, 100_000, 200_000, 30_000)).toBe(110_000);
    expect(siSettledSen(100_000, 200_000, 30_000)).toBe(330_000);
    expect(siCreditNotesSen({ credit_notes_sen: 30_000 })).toBe(30_000);
    expect(siCreditNotesSen({ credit_notes_sen: null })).toBe(0);
    expect(siCreditNotesSen(undefined)).toBe(0);
    expect(siCreditNotesSen({ credit_notes_sen: -1 })).toBe(0);
  });

  test('it never goes negative — an over-payment is a credit, not a debt', () => {
    expect(siOutstandingSen(100_000, 150_000, 0, 0)).toBe(0);
    expect(siOutstandingSen(100_000, 0, 150_000, 0)).toBe(0);
    expect(siOutstandingSen(100_000, 0, 50_000, 60_000)).toBe(0);
  });

  test('an absent or unreadable deposit reads as zero, never as a guess', () => {
    expect(siDepositAppliedSen(undefined)).toBe(0);
    expect(siDepositAppliedSen(null)).toBe(0);
    expect(siDepositAppliedSen({})).toBe(0);
    expect(siDepositAppliedSen({ so_deposit_applied_sen: null })).toBe(0);
    expect(siDepositAppliedSen({ so_deposit_applied_sen: Number.NaN })).toBe(0);
    expect(siOutstandingSen(440_000, 0, siDepositAppliedSen(null), siCreditNotesSen(null))).toBe(440_000);
  });

  test('a negative stamp cannot inflate what has been settled', () => {
    expect(siDepositAppliedSen({ so_deposit_applied_sen: -5_000 })).toBe(0);
  });
});

const REPO_ROOT = (() => {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(d, 'frontend/package.json')) && existsSync(resolve(d, 'backend/package.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo root not found from ${process.cwd()}`);
})();

const SURFACES: Array<{ file: string; anchor: string; span: number; mustCall: string; why: string }> = [
  {
    file: 'src/pages/scm-v2/SalesInvoicesListV2.tsx',
    anchor: 'const outstandingOf = (r: SiRow)',
    span: 400,
    mustCall: 'siOutstandingSen',
    why: 'the Outstanding column, the cards view and the CSV export all read this',
  },
  {
    file: 'src/pages/scm-v2/SalesInvoicesListV2.tsx',
    anchor: 'outstandingSen +=',
    span: 200,
    mustCall: 'siOutstandingSen',
    why: 'the list Outstanding KPI card — the figure that read 10,200 on production',
  },
  {
    file: 'src/pages/scm-v2/SalesInvoicesListV2.tsx',
    anchor: 'const depositSen = siDepositAppliedSen(row)',
    span: 200,
    mustCall: 'siOutstandingSen',
    why: 'the list quick-view drawer computed its own balance inline',
  },
  {
    file: 'src/pages/scm-v2/SalesInvoiceDetailV2.tsx',
    anchor: 'const outstandingOf = (h: SiHeader',
    span: 300,
    mustCall: 'siOutstandingSen',
    why: 'the detail hero, the mobile-viewport hero and the payment gates',
  },
  {
    file: 'src/mobile/MobileModuleList.tsx',
    anchor: 'const balanceSen = (r: any)',
    span: 500,
    mustCall: 'siOutstandingSen',
    why: 'the mobile sales-invoice card footer and quick-view Balance',
  },
  {
    file: 'src/mobile/MobileModuleDetail.tsx',
    anchor: 'const depositSen = siDepositAppliedSen(h)',
    span: 300,
    mustCall: 'siOutstandingSen',
    why: 'the mobile SI detail Balance stat',
  },
  {
    file: 'src/mobile/MobileModuleDetail.tsx',
    anchor: 'const balance = siOutstandingSen(total, paid,',
    span: 200,
    /* The sheet is Sales-Invoice-only since docs/bugs/0889 (a purchase invoice is
       paid with an AP Payment), so the deposit is no longer gated on a kind. */
    mustCall: 'siOutstandingSen(total, paid, siDepositAppliedSen(header), siCreditNotesSen(header))',
    why: 'the Record-Payment sheet PRE-FILLS this amount — it would ask the customer for the deposit twice',
  },
  {
    file: '../shared/src/vendor/scm/lib/sales-invoice-pdf-render.ts',
    anchor: "drawRow('Outstanding'",
    span: 200,
    mustCall: 'siDeposit',
    why: 'the invoice PDF handed to the customer who paid the deposit',
  },
  {
    file: '../shared/src/vendor/scm/lib/sales-invoice-pdf-render.ts',
    anchor: "drawRow('Outstanding'",
    span: 200,
    mustCall: '- credited',
    why: 'the same paper, after a credit note knocked part of it off',
  },
];

describe('every surface goes through the shared rule', () => {
  for (const s of SURFACES) {
    test(`${s.file} — ${s.why}`, () => {
      const src = readFileSync(resolve(REPO_ROOT, 'frontend', s.file), 'utf8');
      const at = src.indexOf(s.anchor);
      expect(at, `anchor not found: ${s.anchor}`).toBeGreaterThan(-1);
      expect(src.slice(at, at + s.span)).toContain(s.mustCall);
    });
  }

  test('the backend serves the field every one of them reads', () => {
    const be = readFileSync(resolve(REPO_ROOT, 'backend/src/scm/lib/si-order-deposit.ts'), 'utf8');
    expect(be).toContain('so_deposit_applied_sen');
    expect(be).toContain('export async function stampOrderDeposit');
  });
});
