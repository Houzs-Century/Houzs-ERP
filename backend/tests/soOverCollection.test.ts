/* OVER-COLLECTION on a sales order (owner 2026-08-16).
   「需要可以超收 negative 边红色」 — take the money, show the balance negative.

   THE BUG THIS PINS IS NOT THE ARITHMETIC. Refusing an over-payment never
   stopped one; it moved it somewhere far worse. Blocked at the till with the
   customer's cash in hand, the only way to bank it was to go back and re-price
   the ORDER until the total covered the money — and that is exactly what
   production shows on the owner's own HC-SO-2608-002 (probe-so-overpay.mjs,
   run 31938591487, prod audit log):

     10:05:31  CREATE          localTotalSen = 400000
     10:05:37  ADD_PAYMENT     200000
     08:26:22  UPDATE_LINE     JAGER-(K) unitPriceSen 0 -> 25000,
                               customSpecials += "Right Drawer" surchargeSen 25000
     08:27:38  ADD_PAYMENT     225000     <- 76 seconds later, now accepted

   200000 + 225000 = 425000 was over the 400000 total, so the guard refused it;
   after the line edit the total WAS 425000 and the same payment sailed through.
   The receipt balanced and the customer's order had grown a drawer he never
   ordered. An item is not a rounding cell — it gets manufactured and delivered.

   So the tests below come in two halves, and the second is the load-bearing
   one: the arithmetic (a negative balance, exact to the sen), and the ABSENCE
   of any write to lines or totals on the payment routes. */

import { describe, expect, test } from 'vitest';
import { soPaidSen, soBalanceSen, soOutstandingSen } from '../src/scm/shared/so-outstanding';

/* Same shape the SO detail page builds via soPaidInputsOf. RM 4,000 order. */
const order = {
  totalRevenueSen: 400_000,
  headerDepositSen: 0,
  ledgerPaidSen: 0,
  depositInLedger: false,
};

describe('the signed balance a human is shown', () => {
  test('an exact payment still balances to zero', () => {
    expect(soBalanceSen({ ...order, ledgerPaidSen: 400_000 })).toBe(0);
  });

  test('an under-payment is positive — the ordinary case is unchanged', () => {
    expect(soBalanceSen({ ...order, ledgerPaidSen: 200_000 })).toBe(200_000);
  });

  /* The owner's number, to the sen. RM 4,000 order, RM 4,250 collected. */
  test('an over-collection is negative by EXACTLY the excess, in centi', () => {
    expect(soBalanceSen({ ...order, ledgerPaidSen: 425_000 })).toBe(-25_000);
  });

  test('the excess is exact at one sen, not rounded or floored away', () => {
    expect(soBalanceSen({ ...order, ledgerPaidSen: 400_001 })).toBe(-1);
  });

  /* A legacy header deposit is still money received, so it still drives the
     balance negative — the deposit rule and the sign rule compose. */
  test('a legacy header deposit over-collects too', () => {
    const legacyDeposit = { ...order, headerDepositSen: 425_000, depositInLedger: false };
    expect(soPaidSen(legacyDeposit)).toBe(425_000);
    expect(soBalanceSen(legacyDeposit)).toBe(-25_000);
  });

  test('a deposit already in the ledger is not counted twice into a false credit', () => {
    expect(soBalanceSen({
      ...order, headerDepositSen: 400_000, ledgerPaidSen: 400_000, depositInLedger: true,
    })).toBe(0);
  });

  /* THE GUARD THAT KEEPS 2,121 PRODUCTION ORDERS OUT OF THE RED. total_revenue_sen
     is 0 on 2,687 of prod's 2,824 live orders — every AutoCount import, where
     the real total sits in local_total_sen (probe run 31938735652 section b).
     Those rows carry real payments, so a bare `total - paid` would paint them
     all a large angry red for money nobody over-collected. Zero total means
     UNKNOWN, not "owes nothing". */
  test('a zero total answers 0, NOT a huge negative, even with money against it', () => {
    expect(soBalanceSen({ ...order, totalRevenueSen: 0, ledgerPaidSen: 990_000 })).toBe(0);
    expect(soBalanceSen({ ...order, totalRevenueSen: 0, ledgerPaidSen: 0 })).toBe(0);
  });
});

/* The write-back's rule is a DIFFERENT rule and must not have moved with it.
   AutoCount's UDF_BALANCE is a licensed ledger; a screen may say "you are
   holding RM 250 of his money", that column may not. */
describe('the clamped rule the AutoCount write-back still uses', () => {
  test('an overpaid order writes back 0, never negative', () => {
    expect(soOutstandingSen({ ...order, ledgerPaidSen: 425_000 })).toBe(0);
  });

  test('the two rules agree on every non-over-collected order', () => {
    for (const paid of [0, 1, 199_999, 200_000, 399_999, 400_000]) {
      expect(soOutstandingSen({ ...order, ledgerPaidSen: paid }))
        .toBe(soBalanceSen({ ...order, ledgerPaidSen: paid }));
    }
  });

  test('and diverge only past the total, which is the whole point of two names', () => {
    const over = { ...order, ledgerPaidSen: 425_000 };
    expect(soOutstandingSen(over)).toBe(0);
    expect(soBalanceSen(over)).toBe(-25_000);
  });
});

/* ── The routes ──────────────────────────────────────────────────────────────
   WHY A SOURCE TEST: what must be true here is the ABSENCE of a guard and the
   ABSENCE of a write, and the handlers are Supabase-backed (`c.get('supabase')`)
   with no binding in this suite. An absence is precisely what a later tidy-up
   re-adds without noticing. Same technique, and the same reason, as
   tests/paymentSlipAttach.test.ts. */

const sources = import.meta.glob('../src/scm/routes/mfg-sales-orders.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? '';

/** Strip comments so the assertions read CODE, not the prose explaining it —
 *  the handlers' own docblocks quote the incident and name `over_payment`. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Body of the handler registered for `method` + `path`, up to the next route
 *  registration. Slicing matters: the SO header routes legitimately recompute
 *  totals and rewrite lines, and asserting over the whole file would let those
 *  mask a re-added write on a PAYMENT route. */
const handlerBody = (method: string, path: string): string => {
  const marker = `mfgSalesOrders.${method}('${path}'`;
  const start = routeSource.indexOf(marker);
  expect(start, `${method.toUpperCase()} ${path} is not registered`).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
};

const PAYMENT_ROUTES: ReadonlyArray<[string, string]> = [
  ['post', '/:docNo/payments'],
  ['patch', '/:docNo/payments/:id'],
  ['delete', '/:docNo/payments/:id'],
];

describe('the payment routes accept an over-collection', () => {
  test('the source loaded (a silent empty glob must not pass)', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("mfgSalesOrders.post('/:docNo/payments'");
    expect(routeSource).toContain("mfgSalesOrders.patch('/:docNo/payments/:id'");
  });

  test('no payment route refuses a payment for exceeding the total', () => {
    for (const [method, path] of PAYMENT_ROUTES) {
      expect(handlerBody(method, path), `${method} ${path} still refuses an over-payment`)
        .not.toContain('over_payment');
    }
  });

  /* Belt and braces: the error code is gone from the file entirely, so a
     helper that returns it cannot smuggle the refusal back past the slice. */
  test("the 'over_payment' error code is gone from the route file", () => {
    expect(stripComments(routeSource)).not.toContain('over_payment');
  });
});

/* THE REGRESSION THE OWNER ACTUALLY HIT. Recording money must not be able to
   move an item, a price, a special or the order total — whatever the amount. */
describe('recording a payment cannot touch the order itself', () => {
  test('no payment route writes to the line-items table', () => {
    for (const [method, path] of PAYMENT_ROUTES) {
      expect(handlerBody(method, path), `${method} ${path} reaches mfg_sales_order_items`)
        .not.toContain('mfg_sales_order_items');
    }
  });

  test('no payment route recomputes the header totals', () => {
    for (const [method, path] of PAYMENT_ROUTES) {
      expect(handlerBody(method, path), `${method} ${path} calls recomputeTotals`)
        .not.toContain('recomputeTotals');
    }
  });

  /* The columns the owner watched move. None of them may be written from a
     payment route — `total_revenue_sen` and `local_total_sen` are read by
     the balance rule, and a read is fine; an UPDATE naming them is not. */
  test('no payment route updates a money column on the order header', () => {
    for (const [method, path] of PAYMENT_ROUTES) {
      const body = handlerBody(method, path);
      const updatesSalesOrders = /\.from\(\s*'mfg_sales_orders'\s*\)[\s\S]{0,200}?\.update\(/.test(body);
      expect(updatesSalesOrders, `${method} ${path} updates mfg_sales_orders`).toBe(false);
    }
  });

  test('the guard removal did not take the amount validation with it', () => {
    // A payment is still an integer number of sen, and still non-negative.
    expect(routeSource).toContain('amountSen:        z.number().int().nonnegative()');
  });
});
