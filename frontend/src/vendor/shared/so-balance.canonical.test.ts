import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { soBalanceOf, soReceivableOf, soOverCollectedOf } from './so-balance';

/* The SO balance is drawn by FIVE surfaces — the SO detail page, the SO list
   Balance column, the desktop Payments summary, the mobile SO detail and the
   customer-facing PDF — plus the server, which sends the same figure to
   AutoCount. Before 2026-08-16 each of them wrote `total - paid` out by hand
   and floored it, and the floor is why an over-collection was unrepresentable:
   the ERP refused the money, so an operator recorded RM 250 of cash by raising
   a line price instead. Owner's ruling: 「需要可以超收 negative 边红色」.

   This file is the referee for the copy. `check-shared-mirrors.mjs` reports the
   pair, but a report is not a gate — the byte test below is. */
describe('the frontend copy IS the backend rule', () => {
  test('byte-identical to backend/src/scm/shared/so-balance.ts', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/so-balance.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/so-balance.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('soBalanceOf — the signed balance the screens draw', () => {
  test('positive while the order is owed money', () => {
    expect(soBalanceOf(400_00, 200_00)).toBe(200_00);
    expect(soBalanceOf(400_00, 400_00)).toBe(0);
  });

  test('NEGATIVE once more is collected than the order is worth', () => {
    expect(soBalanceOf(400_00, 425_00)).toBe(-25_00);
  });

  /* The condition that keeps the unfloor safe, and the one a frontend reader is
     most likely to "simplify" away. Production 2026-08-16: 2,739 of 2,824
     non-cancelled SOs carry total_revenue_centi = 0 from the AutoCount cutover,
     and 2,121 of those are genuinely OWED money. A total of 0 means "unknown",
     never "worth nothing", so no credit is claimed against it. */
  test('a zero or missing total never renders as a credit', () => {
    expect(soBalanceOf(0, 99_00)).toBe(0);
    expect(soBalanceOf(0, 0)).toBe(0);
  });
});

describe('soReceivableOf / soOverCollectedOf — the two halves an aggregate needs', () => {
  test('an over-collected order adds NOTHING to a receivable total', () => {
    expect(soReceivableOf(400_00, 425_00)).toBe(0);
    expect(soOverCollectedOf(400_00, 425_00)).toBe(25_00);
  });
});
