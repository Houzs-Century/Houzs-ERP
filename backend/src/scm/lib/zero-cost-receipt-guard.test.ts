/* The zero-price receipt gate. Route-level coverage is not possible in this
   repo's harness (scm rides Supabase Postgres, the harness rebuilds only the D1
   side), so these pin the pure rule the post chokepoint delegates to, plus the
   chokepoint helper driven through a minimal fake PostgREST client.

   Every test here fails if the guard is deleted: findUncostedReceiptLines is
   the only thing standing between a zero-priced PO line and a zero-cost FIFO
   lot, and the "refuses" cases assert a non-empty result. */
import { describe, expect, test } from 'vitest';
import {
  findUncostedReceiptLines,
  checkReceiptCosts,
  loadKnownPurchaseCostSen,
  zeroCostReceiptResponse,
  ZERO_COST_RECEIPT_ERROR,
  type ReceiptCostLine,
} from './zero-cost-receipt-guard';

const line = (over: Partial<ReceiptCostLine> = {}): ReceiptCostLine => ({
  id: 'gi-1',
  materialCode: 'TRION (A) (HB STR)-(K)',
  qtyAccepted: 1,
  unitCostSen: 0,
  itemGroup: 'bedframe',
  ...over,
});

describe('findUncostedReceiptLines — the rule', () => {
  test('refuses a zero-priced line whose SKU has a known purchase cost', () => {
    const out = findUncostedReceiptLines(
      [line()],
      new Map([['TRION (A) (HB STR)-(K)', 87000]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ materialCode: 'TRION (A) (HB STR)-(K)', knownUnitCostSen: 87000 });
  });

  test('allows a zero-priced line whose SKU has never been bought at a price — GWP / demo / display', () => {
    // The discriminator the owner confirmed and backfill-zero-cost-lots.mjs
    // uses: no purchase price anywhere means zero really is the cost.
    expect(findUncostedReceiptLines([line({ materialCode: 'GN-VM PILLOW-DEMO' })], new Map())).toEqual([]);
    expect(
      findUncostedReceiptLines(
        [line({ materialCode: 'GN-VM PILLOW-DEMO' })],
        new Map([['GN-VM PILLOW-DEMO', 0]]),
      ),
    ).toEqual([]);
  });

  test('allows a priced line', () => {
    expect(
      findUncostedReceiptLines([line({ unitCostSen: 87000 })], new Map([['TRION (A) (HB STR)-(K)', 87000]])),
    ).toEqual([]);
  });

  test('a line rescued by allocated freight is priced, so it is not an offender', () => {
    // postGrnAndRollup passes the LANDED cost (base + freight share), so a line
    // whose supplier price is 0 but which carries freight is genuinely costed.
    expect(
      findUncostedReceiptLines([line({ unitCostSen: 1250 })], new Map([['TRION (A) (HB STR)-(K)', 87000]])),
    ).toEqual([]);
  });

  test('an explicit per-line acknowledgement lets a genuine freebie through', () => {
    expect(
      findUncostedReceiptLines([line({ zeroCostAck: true })], new Map([['TRION (A) (HB STR)-(K)', 87000]])),
    ).toEqual([]);
  });

  test('a SERVICE line is never an offender — it creates no inventory movement', () => {
    expect(
      findUncostedReceiptLines(
        [line({ materialCode: 'SVC-DELIVERY', itemGroup: 'service' })],
        new Map([['SVC-DELIVERY', 5000]]),
      ),
    ).toEqual([]);
  });

  test('a zero-quantity line books no stock, so it is not an offender', () => {
    expect(
      findUncostedReceiptLines([line({ qtyAccepted: 0 })], new Map([['TRION (A) (HB STR)-(K)', 87000]])),
    ).toEqual([]);
  });

  test('matches the known-cost map case- and whitespace-insensitively', () => {
    const out = findUncostedReceiptLines(
      [line({ materialCode: '  trion (a)  (hb str)-(k) ' })],
      new Map([['TRION (A) (HB STR)-(K)', 87000]]),
    );
    expect(out).toHaveLength(1);
  });

  test('reports every offending line, not just the first', () => {
    const out = findUncostedReceiptLines(
      [line({ id: 'a' }), line({ id: 'b', materialCode: 'REGAL (A)-(Q)' }), line({ id: 'c', unitCostSen: 500 })],
      new Map([['TRION (A) (HB STR)-(K)', 87000], ['REGAL (A)-(Q)', 70000]]),
    );
    expect(out.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('zeroCostReceiptResponse', () => {
  test('names the error and carries the offending lines', () => {
    const body = zeroCostReceiptResponse([
      { id: 'a', materialCode: 'REGAL (A)-(Q)', qtyAccepted: 2, knownUnitCostSen: 70000 },
    ]);
    expect(body.error).toBe(ZERO_COST_RECEIPT_ERROR);
    expect(body.lines).toHaveLength(1);
  });
});

/** Minimal chainable, awaitable PostgREST stand-in for the single lot read. */
function fakeSb(lots: Array<Record<string, unknown>>, opts: { throwOnRead?: boolean } = {}) {
  class Q {
    rows: Array<Record<string, unknown>>;
    constructor(rows: Array<Record<string, unknown>>) { this.rows = [...rows]; }
    select() { return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    gt(col: string, v: number) { this.rows = this.rows.filter((r) => Number(r[col]) > v); return this; }
    eq(col: string, v: unknown) { this.rows = this.rows.filter((r) => r[col] === v); return this; }
    limit() { return this; }
    order(col: string, o: { ascending: boolean }) {
      this.rows.sort((a, b) => (String(a[col]) < String(b[col]) ? 1 : -1) * (o.ascending ? -1 : 1));
      return this;
    }
    then<T>(onF: (v: { data: Array<Record<string, unknown>>; error: null }) => T, onR?: (e: unknown) => T) {
      if (opts.throwOnRead) return Promise.reject(new Error('db down')).then(onF as never, onR);
      return Promise.resolve({ data: this.rows, error: null }).then(onF, onR);
    }
  }
  return { from: () => new Q(lots) };
}

const LOTS = [
  { product_code: 'TRION (A) (HB STR)-(K)', unit_cost_sen: 87000, received_at: '2026-06-01', company_id: 1 },
  { product_code: 'TRION (A) (HB STR)-(K)', unit_cost_sen: 99000, received_at: '2025-01-01', company_id: 1 },
  { product_code: 'REGAL (A)-(Q)', unit_cost_sen: 70000, received_at: '2026-05-01', company_id: 1 },
  { product_code: 'OTHERCO ONLY', unit_cost_sen: 55000, received_at: '2026-05-01', company_id: 2 },
];

describe('loadKnownPurchaseCostSen', () => {
  test('takes the MOST RECENT priced lot, never the maximum', async () => {
    // MAX would answer 99000 here. An audit measured MAX overstating 28 of 319
    // AutoCount lines by RM14,244 because one invoice carries several builds of
    // the same item code, so this resolver must not reach for it.
    const known = await loadKnownPurchaseCostSen(fakeSb(LOTS), ['TRION (A) (HB STR)-(K)'], 1);
    expect(known.get('TRION (A) (HB STR)-(K)')).toBe(87000);
  });

  test('is company-scoped — another company\'s cost is not evidence', async () => {
    const known = await loadKnownPurchaseCostSen(fakeSb(LOTS), ['OTHERCO ONLY'], 1);
    expect(known.has('OTHERCO ONLY')).toBe(false);
  });

  test('a failed read yields no evidence, which allows the post', async () => {
    const known = await loadKnownPurchaseCostSen(fakeSb(LOTS, { throwOnRead: true }), ['REGAL (A)-(Q)'], 1);
    expect(known.size).toBe(0);
  });
});

describe('checkReceiptCosts — the chokepoint helper', () => {
  test('refuses the receipt that would open a zero-cost layer', async () => {
    const res = await checkReceiptCosts(fakeSb(LOTS), [line()], 1);
    expect(res?.error).toBe(ZERO_COST_RECEIPT_ERROR);
    expect(res?.lines[0]).toMatchObject({ knownUnitCostSen: 87000 });
  });

  test('lets a genuinely free SKU through', async () => {
    expect(await checkReceiptCosts(fakeSb(LOTS), [line({ materialCode: 'GN-VM PILLOW-DEMO' })], 1)).toBeNull();
  });

  test('lets a fully priced receipt through without reading the ledger', async () => {
    let reads = 0;
    const sb = { from: () => { reads++; return fakeSb(LOTS).from(); } };
    expect(await checkReceiptCosts(sb, [line({ unitCostSen: 87000 })], 1)).toBeNull();
    expect(reads).toBe(0);
  });

  test('a read failure does not block the receipt', async () => {
    expect(await checkReceiptCosts(fakeSb(LOTS, { throwOnRead: true }), [line()], 1)).toBeNull();
  });
});
