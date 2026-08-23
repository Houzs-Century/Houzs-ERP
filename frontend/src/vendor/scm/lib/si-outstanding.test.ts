// Every screen that shows what a Sales Invoice owes must answer the SAME number.
//
// WHAT THIS PINS, and why a unit test of the arithmetic alone would not have
// caught the bug it exists for. On 2026-08-23 the rule was correct and lived in
// this file's ancestor — and only the DETAIL page called it. Measured on
// production the same day, `HC-SI-2608-004` read 2,400 on the detail page and
// 4,400 on the list, the list's Outstanding KPI, the cards, the mobile card,
// the /scm/outstanding ledger and the PDF handed to the customer. The list is
// the screen the office scans to decide who to chase, so the half that was
// wrong was the half the owner complained about.
//
// So the second half of this file reads the SOURCE of each surface and asserts
// it goes through the shared rule. A source assertion is unusual and it is
// deliberate: the failure mode here is a screen that never calls the function,
// which no amount of testing the function can see.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { siDepositAppliedSen, siSettledSen, siOutstandingSen } from './si-outstanding';

describe('the rule', () => {
  test('the order deposit settles the invoice alongside its own receipts', () => {
    // The owner's reported chain: 4,400 invoice, 2,000 taken on the order.
    expect(siOutstandingSen(440_000, 0, 200_000)).toBe(240_000);
    expect(siSettledSen(0, 200_000)).toBe(200_000);
  });

  test('the two kinds of money add up rather than replacing one another', () => {
    expect(siOutstandingSen(440_000, 100_000, 200_000)).toBe(140_000);
  });

  test('it never goes negative — an over-payment is a credit, not a debt', () => {
    expect(siOutstandingSen(100_000, 150_000, 0)).toBe(0);
    expect(siOutstandingSen(100_000, 0, 150_000)).toBe(0);
  });

  /* A missing field means the server could NOT resolve the order, and it must
     read as zero deposit — which shows the LARGER outstanding. Over-stating
     sends someone to check; under-stating loses the money. */
  test('an absent or unreadable deposit reads as zero, never as a guess', () => {
    expect(siDepositAppliedSen(undefined)).toBe(0);
    expect(siDepositAppliedSen(null)).toBe(0);
    expect(siDepositAppliedSen({})).toBe(0);
    expect(siDepositAppliedSen({ so_deposit_applied_sen: null })).toBe(0);
    expect(siDepositAppliedSen({ so_deposit_applied_sen: Number.NaN })).toBe(0);
    expect(siOutstandingSen(440_000, 0, siDepositAppliedSen(null))).toBe(440_000);
  });

  test('a negative stamp cannot inflate what has been settled', () => {
    expect(siDepositAppliedSen({ so_deposit_applied_sen: -5_000 })).toBe(0);
  });
});

/* Each entry is ONE surface that renders a Sales Invoice balance, anchored on a
   string unique to the region that computes it. `mustCall` is what the region
   has to reach for. Deleting any surface's call to the shared rule fails here.

   The two mobile files are shared with PURCHASE invoices, whose own
   `Math.max(0, total - paid)` is correct and must NOT be swept up — which is
   why these anchors name a region rather than scanning a whole file. */
/* The repo root, found by walking up from wherever the runner started. Vitest
   is invoked with cwd = `frontend/` in CI and cwd = the repo root locally, and a
   path that resolves in only one of those is a guard that silently stops
   guarding in the other. */
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
    mustCall: 'kind === "si" ? siDepositAppliedSen(header)',
    why: 'the Record-Payment sheet PRE-FILLS this amount — it would ask the customer for the deposit twice',
  },
  {
    file: 'src/vendor/scm/lib/sales-invoice-pdf.ts',
    anchor: "drawRow('Outstanding'",
    span: 200,
    mustCall: 'siDeposit',
    why: 'the invoice PDF handed to the customer who paid the deposit',
  },
];

describe('every surface goes through the shared rule', () => {
  for (const s of SURFACES) {
    test(`${s.file} — ${s.why}`, () => {
      const src = readFileSync(resolve(REPO_ROOT, 'frontend', s.file), 'utf8');
      const at = src.indexOf(s.anchor);
      /* A moved or renamed anchor is a FINDING, not a pass. A source guard whose
         pattern no longer matches must fail loudly — CLAUDE.md, "a checker that
         cannot match reports a clean run". */
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
