/* ac-chain-line-grain — the PO -> GR -> PI chain, measured at LINE grain.
 *
 * WHY THIS TEST EXISTS. On 2026-09-08 the price stamper looked at nine goods
 * receipts, computed the right figure to the sen, and refused to write it. Its
 * stated reason:
 *
 *   "our receipt mirrors ONE purchase order and AutoCount's receipt spans
 *    several, so the invoice bills more than our lines cover"
 *
 * The owner rejected that reading:
 *
 *   「PI 是from multiple的PO 所以GR的吧? 没有啊 我们一张GR to 一张PI —
 *     可是GR 会from multiple PO啊 — 所以你要去GR 每个line的amount 都对齐啊 —
 *     PO GR PI的line information去吧要对其啊」
 *
 * He is right, and the schema says so: `grns.purchase_order_id` is NOT NULL and
 * names ONE order, while `grn_items.purchase_order_item_id` is per line and
 * NULLABLE. The LINES already model a multi-order receipt. The refusal was a
 * DOCUMENT-TOTAL measurement wearing a line-level explanation — a checker
 * counting its own guess.
 *
 * The defect is arithmetic: the gate compared an ERP group's total against the
 * WHOLE invoice's NetTotal, when the ERP deliberately mirrors only the
 * (receipt x order) pairs the migration carried. The remainder is out-of-scope
 * money that no price can conjure and none is missing.
 *
 * Every case below is a planted defect, because none of them can be exercised
 * against production without first creating the damage there.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, it, expect } from 'vitest';

import {
  buildChain, expectedForPairs, invoiceIdentity, pairKey, invoiceGateVerdict,
} from '../scripts/lib/ac-chain-line-grain.mjs';
import { buildScope, decodeSnapshot } from '../scripts/lib/ac-scope.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── a miniature book, in the snapshot's decoded shape ───────────────────── */

const grLine = (over = {}) => ({
  docNo: 'GR-1', dtlKey: '1', seq: 16, itemKey: 'SOFA', qty: 1,
  unitPriceSen: 100000, subTotalSen: 100000, fromDocType: 'PO', fromDocNo: 'PO-1', ...over,
});
const piLine = (over = {}) => ({
  docNo: 'PI-1', dtlKey: '9', seq: 16, itemKey: 'SOFA', qty: 1,
  unitPriceSen: 100000, subTotalSen: 100000, fromDocType: 'GR', fromDocNo: 'GR-1', ...over,
});

/** One receipt drawn from TWO purchase orders, billed by ONE invoice.
 *  PO-1 is in the migration scope; PO-2 is not (already fully received). */
function twoOrderBook() {
  return {
    book: {
      GR: {
        headers: new Map([['GR-1', { docNo: 'GR-1', cancelled: false, currency: 'MYR', rate: 1 }]]),
        lines: new Map([['GR-1', [
          grLine({ dtlKey: '11', seq: 16, itemKey: 'SOFA-A', subTotalSen: 308000, unitPriceSen: 308000, fromDocNo: 'PO-1' }),
          grLine({ dtlKey: '12', seq: 32, itemKey: 'PILLOW', qty: 4, subTotalSen: 12000, unitPriceSen: 3000, fromDocNo: 'PO-1' }),
          grLine({ dtlKey: '13', seq: 48, itemKey: 'SOFA-B', subTotalSen: 295000, unitPriceSen: 295000, fromDocNo: 'PO-2' }),
        ]]]),
      },
      PI: {
        headers: new Map([['PI-1', { docNo: 'PI-1', cancelled: false }]]),
        lines: new Map([['PI-1', [
          piLine({ dtlKey: '21', subTotalSen: 308000 }),
          piLine({ dtlKey: '22', seq: 32, qty: 4, subTotalSen: 12000 }),
          piLine({ dtlKey: '23', seq: 48, subTotalSen: 295000 }),
        ]]]),
      },
    },
    refs: { piMeta: { 'PI-1': { netTotal: 6150, cancelled: false } }, ivMeta: {} },
  };
}

describe('the chain is keyed on document links, never on position or name', () => {
  it('splits a receipt across the purchase orders its own lines name', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    expect(chain.pairTotalSen.get(pairKey('GR-1', 'PO-1'))).toBe(320000);
    expect(chain.pairTotalSen.get(pairKey('GR-1', 'PO-2'))).toBe(295000);
  });

  it('attributes the same money when the book states the lines in another order', () => {
    const { book, refs } = twoOrderBook();
    book.GR.lines.get('GR-1').reverse();
    book.PI.lines.get('PI-1').reverse();
    const chain = buildChain(book, refs);
    /* Reversing is the 0690 defect made visible: a positional pairing would
       hand PO-1's money to PO-2. The pair key does not move. */
    expect(chain.pairTotalSen.get(pairKey('GR-1', 'PO-1'))).toBe(320000);
    expect(chain.pairTotalSen.get(pairKey('GR-1', 'PO-2'))).toBe(295000);
  });

  it('states the book money for exactly the pairs the ERP holds', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    expect(expectedForPairs(chain, [pairKey('GR-1', 'PO-1')])).toEqual({ sen: 320000, unknown: [] });
    expect(expectedForPairs(chain, [pairKey('GR-1', 'PO-1'), pairKey('GR-1', 'PO-2')]))
      .toEqual({ sen: 615000, unknown: [] });
  });

  it('names a pair the book does not state instead of scoring it as zero', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    const got = expectedForPairs(chain, [pairKey('GR-1', 'PO-1'), pairKey('GR-1', 'PO-9')]);
    expect(got.unknown).toEqual([pairKey('GR-1', 'PO-9')]);
  });
});

describe('the invoice cross-check stays, and it is the BOOK against itself', () => {
  it('agrees when the invoice lines sum to the header the other export states', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    expect(invoiceIdentity(chain, 'PI-1')).toMatchObject({ agree: true, lineSumSen: 615000, netTotalSen: 615000 });
  });

  it('REFUSES when the two independent exports of the same book disagree', () => {
    const { book, refs } = twoOrderBook();
    refs.piMeta['PI-1'].netTotal = 6000; // the header export drifted from the line export
    const chain = buildChain(book, refs);
    expect(invoiceIdentity(chain, 'PI-1').agree).toBe(false);
  });
});

describe('the gate the nine goods receipts were refused by', () => {
  const erpDoc = (docNo, acGr, acPo, totalSen) => ({ docNo, acDocNo: acGr, acScopeNo: acPo, totalSen });

  it('ACCEPTS a partial mirror that matches the book on the pairs it holds', () => {
    /* This is the regression. The old gate asked "does the ERP reach RM 6,150?"
       and the ERP never carried PO-2, so it could not and never will. */
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    const v = invoiceGateVerdict(chain, 'PI-1', [erpDoc('HC-GR-1', 'GR-1', 'PO-1', 320000)]);
    expect(v.accepted).toBe(true);
    expect(v.expectedSen).toBe(320000);
    expect(v.outOfScopeSen).toBe(295000);
  });

  it('still REFUSES when our lines genuinely differ from the book on a pair we DO hold', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    const v = invoiceGateVerdict(chain, 'PI-1', [erpDoc('HC-GR-1', 'GR-1', 'PO-1', 319900)]);
    expect(v.accepted).toBe(false);
    expect(v.expectedSen).toBe(320000);
  });

  it('still REFUSES when the book disagrees with its own invoice header', () => {
    const { book, refs } = twoOrderBook();
    refs.piMeta['PI-1'].netTotal = 6000;
    const chain = buildChain(book, refs);
    const v = invoiceGateVerdict(chain, 'PI-1', [erpDoc('HC-GR-1', 'GR-1', 'PO-1', 320000)]);
    expect(v.accepted).toBe(false);
    expect(v.why).toMatch(/export/i);
  });

  it('REFUSES rather than passing an ERP document naming a pair the book never states', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    const v = invoiceGateVerdict(chain, 'PI-1', [erpDoc('HC-GR-1', 'GR-1', 'PO-9', 0)]);
    expect(v.accepted).toBe(false);
  });

  it('adds up: what we hold plus what the migration never carried IS the invoice', () => {
    const { book, refs } = twoOrderBook();
    const chain = buildChain(book, refs);
    const v = invoiceGateVerdict(chain, 'PI-1', [erpDoc('HC-GR-1', 'GR-1', 'PO-1', 320000)]);
    expect(v.expectedSen + v.outOfScopeSen).toBe(v.netTotalSen);
  });
});

describe('the multi-receipt invoice, which is the shape the refusal misread', () => {
  it('handles one invoice billing TWO receipts, only one of which we carry', () => {
    /* PI-007287 in miniature: it draws on GR-1 and GR-2, and the ERP holds one
       (receipt x order) pair of GR-1 and nothing of GR-2. */
    const { book, refs } = twoOrderBook();
    book.GR.headers.set('GR-2', { docNo: 'GR-2', cancelled: false, currency: 'MYR', rate: 1 });
    book.GR.lines.set('GR-2', [grLine({ docNo: 'GR-2', dtlKey: '31', itemKey: 'SOFA-C', subTotalSen: 330000, unitPriceSen: 330000, fromDocNo: 'PO-3' })]);
    book.PI.lines.get('PI-1').push(piLine({ dtlKey: '24', seq: 64, subTotalSen: 330000, fromDocNo: 'GR-2' }));
    refs.piMeta['PI-1'].netTotal = 9450;
    const chain = buildChain(book, refs);
    expect(invoiceIdentity(chain, 'PI-1').agree).toBe(true);
    const v = invoiceGateVerdict(chain, 'PI-1', [{ docNo: 'HC-GR-1', acDocNo: 'GR-1', acScopeNo: 'PO-1', totalSen: 320000 }]);
    expect(v.accepted).toBe(true);
    expect(v.expectedSen).toBe(320000);
    expect(v.outOfScopeSen).toBe(295000 + 330000);
  });
});

describe('a cancelled invoice is not evidence', () => {
  it('is excluded from the chain', () => {
    const { book, refs } = twoOrderBook();
    refs.piMeta['PI-1'].cancelled = true;
    const chain = buildChain(book, refs);
    expect(chain.invoicesOfReceipt.get('GR-1') ?? []).toEqual([]);
  });
});

/* ── THE REAL BOOK ───────────────────────────────────────────────────────────
 * The three figures the stamper printed as "ours would be" on run 34231092897,
 * pinned against the committed snapshot. They are not a coincidence and not a
 * remainder: each is the book's OWN money for exactly the (receipt x order)
 * pairs the ERP carries, and the rest of the invoice is on orders the migration
 * never took. If a re-cut of the snapshot moves any of them, the sentence the
 * owner was given stops being true and this test says so.
 */
describe('the committed AutoCount snapshot — the nine, worked', () => {
  const DATA = resolve(__dirname, '..', 'scripts', 'data');
  const gz = (f) => JSON.parse(gunzipSync(readFileSync(resolve(DATA, f))).toString('utf8').replace(/^\uFEFF/, ''));
  const book = decodeSnapshot(gz('ac-reconcile-truth.json.gz'));
  const refs = gz('ac-invoice-refs.json.gz');
  const chain = buildChain(book, refs);

  it.each([
    ['PI-007287', 1124700, [['GR-004909', 'PO-009017']], 320000],
    ['PI-007765', 458000, [['GR-005169', 'PO-009475']], 223000],
    ['PI-007771', 928400, [['GR-005171', 'PO-009344'], ['GR-005171', 'PO-009553']], 485000],
  ])('%s: ours + never-carried = the whole invoice, to the sen', (pi, netSen, held, oursSen) => {
    expect(invoiceIdentity(chain, pi)).toMatchObject({ agree: true, netTotalSen: netSen });
    const v = invoiceGateVerdict(
      chain, pi,
      held.map(([gr, po], i) => ({
        docNo: `HC-${gr}#${i}`, acDocNo: gr, acScopeNo: po,
        totalSen: chain.pairTotalSen.get(pairKey(gr, po)),
      })),
    );
    expect(v.expectedSen).toBe(oursSen);
    expect(v.expectedSen + v.outOfScopeSen).toBe(netSen);
    expect(v.accepted).toBe(true);
  });

  it('no receipt is ever billed for MORE than its own lines', () => {
    /* The safety property, book-wide. A receipt billed across two invoices is
       normal (GR-001595 is), and four receipts are billed for slightly LESS
       than they hold — two by one sen, two genuinely part-invoiced. Being
       billed for MORE would mean the attribution below can invent money, and
       nothing in the book does that. */
    const over = [];
    for (const [gr, invs] of chain.invoicesOfReceipt) {
      const drew = invs.reduce((s, pi) => s + (chain.drawOnReceiptSen.get(pairKey(pi, gr)) ?? 0), 0);
      const own = chain.receiptTotalSen.get(gr) ?? 0;
      if (drew > own) over.push(`${gr}: billed ${drew}, holds ${own}`);
    }
    expect(over).toEqual([]);
  });

  it('every IN-SCOPE receipt is billed for exactly what it holds', () => {
    /* This is the precondition that makes attribution by document link EXACT
       for the documents we actually act on. It is measured, not assumed: if a
       re-cut of the book breaks it, the reporting arithmetic silently stops
       being defensible and this test says so first. */
    const { book: bk } = chain;
    const scope = buildScope(bk);
    let checked = 0; const off = [];
    for (const gr of scope.GR) {
      const invs = chain.invoicesOfReceipt.get(gr);
      if (!invs) continue;
      checked++;
      const drew = invs.reduce((s, pi) => s + (chain.drawOnReceiptSen.get(pairKey(pi, gr)) ?? 0), 0);
      const own = chain.receiptTotalSen.get(gr) ?? 0;
      if (drew !== own) off.push(`${gr}: billed ${drew}, holds ${own}`);
    }
    expect(checked).toBe(189);
    expect(off).toEqual([]);
  });

  it('a CNY invoice is named as a currency mismatch, NEVER as a broken book', () => {
    /* 20 live purchase invoices have a line sum that does not equal their
       header. Every one is CNY, and every one is off by exactly its own
       exchange rate: the lines are DOCUMENT currency and the header is LOCAL.
       Reading that as a discount is what wrote RM 13,068.55 of imaginary money
       onto a CNY purchase order (docs/bugs/0665, docs/bugs/0721). */
    const mismatched = [...chain.invoiceLineSumSen.keys()]
      .map((pi) => [pi, invoiceIdentity(chain, pi)])
      .filter(([, id]) => !id.agree);
    expect(mismatched.length).toBe(20);
    for (const [, id] of mismatched) {
      expect(id.commensurable).toBe(false);
      expect(id.currency).not.toBe('MYR');
      /* THE GAP IS THE RATE. Applying it closes a ~61% difference to within a
         sen or two — the residue is AutoCount rounding each line, not a
         discount. Both bounds are asserted: a test that only checked the
         converted figure would pass on a book where the rate was 1. */
      expect(Math.abs(id.lineSumSen / id.rate - id.netTotalSen)).toBeLessThanOrEqual(2);
      expect(Math.abs(id.lineSumSen - id.netTotalSen)).toBeGreaterThan(id.netTotalSen * 0.1);
    }
    const cny = mismatched[0][1];
    expect(cny.why).toMatch(/not converted/i);
  });

  it('PI-007287 is MYR, so the two exports are compared and they agree', () => {
    const id = invoiceIdentity(chain, 'PI-007287');
    expect(id).toMatchObject({ currency: 'MYR', commensurable: true, agree: true });
  });

  it('a receipt is split by the order ITS OWN lines name, never by position', () => {
    /* GR-005171 is the four-order receipt from the owner's own example. */
    expect(chain.pairTotalSen.get(pairKey('GR-005171', 'PO-009344'))).toBe(233000);
    expect(chain.pairTotalSen.get(pairKey('GR-005171', 'PO-009365'))).toBe(144400);
    expect(chain.pairTotalSen.get(pairKey('GR-005171', 'PO-009516'))).toBe(299000);
    expect(chain.pairTotalSen.get(pairKey('GR-005171', 'PO-009553'))).toBe(252000);
    expect([...chain.ordersOfReceipt.get('GR-005171')].sort())
      .toEqual(['PO-009344', 'PO-009365', 'PO-009516', 'PO-009553']);
  });
});
