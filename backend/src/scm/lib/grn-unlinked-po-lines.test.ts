// The receiving-side twin of do-unlinked-so-lines, which had ten tests while
// this file had none — and the gap is not academic. Owner, 2026-08-04, after
// 2990-DO-2607-005 and 2990-DO-2607-017 shipped the same six items: "包括 GR
// 那边也是". The same shape on the way IN moves stock the other way: a GRN line
// with no purchase_order_item_id still writes the inventory IN, but ticks
// nothing off the PO, so the same supplier delivery can be received twice.
//
// Every case here asserts a DECISION (refuse / allow), not that a line
// executed. Each has been inverted in the source and observed to fail.

import { describe, it, expect } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { findUnlinkedPoLines, poMaterialCodesOf, unlinkedPoLinesResponse } from './grn-unlinked-po-lines';

const PO_ID = 'po-1';
const line = (lineRef: string, itemCode: string, qty: number, soItemId: string | null = null) => ({
  lineRef,
  itemCode,
  qty,
  soItemId,
});

/** A PO with the given material codes, plus the header row carrying its number. */
const sbWith = (materials: string[], poNumber: string | null = 'HC-PO-2608-001') =>
  fakeSb({
    purchase_orders: [{ id: PO_ID, po_number: poNumber }],
    purchase_order_items: materials.map((m, i) => ({ id: `poi-${i}`, purchase_order_id: PO_ID, material_code: m })),
  });

describe('poMaterialCodesOf', () => {
  it('returns every material the named PO orders, upper-cased and trimmed', () => {
    // The codes are compared against operator-typed GRN lines, so a stray space
    // or a lower-case paste must not read as a different material.
    return expect(poMaterialCodesOf(sbWith([' foam-40d ', 'Fabric-A']), PO_ID)).resolves.toEqual(
      { ok: true, codes: new Set(['FOAM-40D', 'FABRIC-A']) },
    );
  });

  it('is empty when the GRN names no PO — the legitimate free-receipt case', async () => {
    for (const id of [null, undefined, '', '   ']) {
      expect(await poMaterialCodesOf(sbWith(['FOAM-40D']), id)).toEqual({ ok: true, codes: new Set() });
    }
  });

  it('REPORTS a failed read instead of answering "the PO orders nothing"', async () => {
    // An empty set is what the predicate treats as "nothing to bypass", so a
    // swallowed error did not degrade this guard — it DISABLED it.
    const sb = fakeSb(
      { purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, material_code: 'FOAM-40D' }] },
      { purchase_order_items: ['material_code'] },
    );
    expect(await poMaterialCodesOf(sb, PO_ID)).toEqual({ ok: false, reason: expect.stringContaining('material_code') });
  });
});

/** The offenders, insisting the scan SUCCEEDED. Every case below is about the
 *  verdict; a failed parent read is asserted on its own above and must never be
 *  silently read as "no offenders" — which is the bug this shape exists for. */
const offenders = async (...args: Parameters<typeof findUnlinkedPoLines>) => {
  const r = await findUnlinkedPoLines(...args);
  if (!r.ok) throw new Error(`scan failed: ${r.reason}`);
  return r.offenders;
};

describe('findUnlinkedPoLines', () => {
  it('REFUSES an unlinked line receiving a material the named PO already orders', async () => {
    // This is the double-receipt. Without the refusal the stock goes up and the
    // PO's received_qty does not move, so the next delivery of the same goods
    // passes the over-receipt guard too.
    const out = await offenders(sbWith(['FOAM-40D']), PO_ID, 'HC-PO-2608-001', [line('0', 'FOAM-40D', 12)]);
    expect(out).toEqual([
      { lineRef: '0', materialCode: 'FOAM-40D', qty: 12, poNumber: 'HC-PO-2608-001' },
    ]);
  });

  it('REFUSES across a case / whitespace difference on EITHER side', async () => {
    // Both sides are hand-entered, and the refusal is the whole point: a stored
    // " foam-40d " that fails to match a typed "FOAM-40D" reads as a genuinely
    // free receipt and the guard lets the second delivery in.
    const out = await offenders(sbWith([' foam-40d ']), PO_ID, 'HC-PO-2608-001', [
      line('0', '  FOAM-40D', 12),
    ]);
    expect(out).toHaveLength(1);
  });

  it('ALLOWS an unlinked line for a material the PO does not order', async () => {
    // A sample, a supplier freebie, stock found on the floor. Uncapped is right
    // here, and a blanket "every line must link" would block it.
    const out = await offenders(sbWith(['FOAM-40D']), PO_ID, 'HC-PO-2608-001', [line('0', 'SAMPLE-SWATCH', 1)]);
    expect(out).toEqual([]);
  });

  it('ALLOWS a LINKED line — the received-qty ceiling already governs it', async () => {
    const out = await offenders(sbWith(['FOAM-40D']), PO_ID, 'HC-PO-2608-001', [
      line('0', 'FOAM-40D', 12, 'poi-0'),
    ]);
    expect(out).toEqual([]);
  });

  it('ALLOWS everything when the GRN header names no PO', async () => {
    for (const id of [null, undefined, '', '   ']) {
      expect(await offenders(sbWith(['FOAM-40D']), id, 'HC-PO-2608-001', [line('0', 'FOAM-40D', 12)])).toEqual([]);
    }
  });

  it('queries NOTHING when every line is already linked', async () => {
    // Not tidiness: this runs on every GRN post, and a receipt whose lines are
    // all linked must not pay for two reads to be told what the ceiling already
    // knows. Counting `from` is the only way to see a query that did not happen.
    const inner = sbWith(['FOAM-40D']);
    let queries = 0;
    const sb = { from: (t: string) => { queries += 1; return inner.from(t); } };
    const out = await offenders(sb, PO_ID, null, [line('0', 'FOAM-40D', 12, 'poi-0')]);
    expect(out).toEqual([]);
    expect(queries).toBe(0);
  });

  it('still REFUSES when the PO row carries no po_number — the id is the last resort', async () => {
    // The shared predicate needs a non-empty parent label to engage at all, so
    // an empty label would return "no offenders" and the guard would fail OPEN:
    // a PO whose number is null or whose header row is gone would let the same
    // delivery be received twice, silently. The id keeps the rule engaged.
    const noNumber = await offenders(sbWith(['FOAM-40D'], null), PO_ID, null, [line('0', 'FOAM-40D', 12)]);
    expect(noNumber).toEqual([{ lineRef: '0', materialCode: 'FOAM-40D', qty: 12, poNumber: PO_ID }]);

    const noHeaderRow = fakeSb({
      purchase_orders: [],
      purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, material_code: 'FOAM-40D' }],
    });
    expect(await offenders(noHeaderRow, PO_ID, null, [line('0', 'FOAM-40D', 12)])).toEqual([
      { lineRef: '0', materialCode: 'FOAM-40D', qty: 12, poNumber: PO_ID },
    ]);
  });

  it('uses the caller-supplied PO number without re-reading the header', async () => {
    const sb = fakeSb({
      purchase_orders: [],
      purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, material_code: 'FOAM-40D' }],
    });
    const out = await offenders(sb, PO_ID, 'HC-PO-2608-009', [line('0', 'foam-40d', 12)]);
    expect(out[0]?.poNumber).toBe('HC-PO-2608-009');
  });

  it('reports every offending line, and only those', async () => {
    const out = await offenders(sbWith(['FOAM-40D', 'FABRIC-A', 'LEG-SET']), PO_ID, 'HC-PO-2608-001', [
      line('0', 'FOAM-40D', 12),            // on the PO, unlinked -> offender
      line('1', 'FABRIC-A', 30, 'poi-1'),   // linked             -> fine
      line('2', 'SAMPLE-SWATCH', 1),        // not on the PO      -> fine
      line('3', 'LEG-SET', 4),              // on the PO, unlinked -> offender
    ]);
    expect(out.map((o) => o.lineRef)).toEqual(['0', '3']);
  });
});

describe('unlinkedPoLinesResponse', () => {
  it('names the PO and lists each offending material once', () => {
    const body = unlinkedPoLinesResponse([
      { lineRef: '0', materialCode: 'FOAM-40D', qty: 12, poNumber: 'HC-PO-2608-001' },
      { lineRef: '1', materialCode: 'FOAM-40D', qty: 6, poNumber: 'HC-PO-2608-001' },
      { lineRef: '2', materialCode: 'FABRIC-A', qty: 30, poNumber: 'HC-PO-2608-001' },
    ]);
    expect(body.error).toBe('unlinked_po_lines');
    expect(body.poNumber).toBe('HC-PO-2608-001');
    expect(body.message).toContain('FOAM-40D, FABRIC-A');
    // The count is of LINES, not distinct materials — three rows are wrong here.
    expect(body.message).toContain('3 line(s)');
    expect(body.offenders).toHaveLength(3);
  });
});
