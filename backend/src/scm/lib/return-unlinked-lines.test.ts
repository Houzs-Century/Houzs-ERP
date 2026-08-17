// The two RETURN chains inherit the rule that closed the delivery and receiving
// sides on 2026-08-04 (docs/unlinked-line-duplicate-coe.md).
//
// A production scan the same day found ZERO rows of this shape on either chain,
// so these guards are preventative. That is the argument FOR adding them, not
// against: the cost is one query on a path already doing several, and the cost
// of not having it on the delivery side was three weeks of a double deduction
// nobody could see.

import { describe, it, expect } from 'vitest';
import {
  unlinkedReturnResponse, findUnlinkedPiLines, unlinkedInvoiceResponse,
  type UnlinkedReturnOffender,
} from './return-unlinked-lines';
// Source text of the PI router, so the WIRING is asserted too.
import piRouterSrc from '../routes/purchase-invoices.ts?raw';

const off = (itemCode: string, qty = 1, parentNo = '2990-DO-2607-017'): UnlinkedReturnOffender =>
  ({ lineRef: '0', itemCode, qty, parentNo });

describe('unlinkedReturnResponse', () => {
  it('names the Delivery Order and the items, for a delivery return', () => {
    const body = unlinkedReturnResponse([off('NTYR-PILLOW'), off('MATTRESS-Q')], 'delivery');
    expect(body.error).toBe('unlinked_do_lines');
    expect(body.parentNo).toBe('2990-DO-2607-017');
    expect(body.message).toContain('Delivery Order 2990-DO-2607-017');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.message).toContain('2 line(s)');
  });

  it('names the Goods Receipt for a purchase return, with its own error code', () => {
    // Distinct codes so the two surfaces can show their own copy — a DR and a
    // PR fail for the same reason but the operator's next action differs.
    const body = unlinkedReturnResponse([off('FOAM-A', 3, '2990-GRN-2607-001')], 'purchase');
    expect(body.error).toBe('unlinked_grn_lines');
    expect(body.message).toContain('Goods Receipt 2990-GRN-2607-001');
    expect(body.message).toContain('1 line(s)');
  });

  it('de-duplicates the item list but counts LINES', () => {
    // Three offending rows, two distinct items: the count is of rows, because
    // that is what the operator has to fix.
    const body = unlinkedReturnResponse(
      [off('NTYR-PILLOW'), off('NTYR-PILLOW'), off('MATTRESS-Q')], 'delivery',
    );
    expect(body.message).toContain('3 line(s)');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.offenders).toHaveLength(3);
  });

  it('explains WHY it is refused, not just that it is', () => {
    const body = unlinkedReturnResponse([off('NTYR-PILLOW')], 'delivery');
    expect(body.message).toContain('the same goods can be returned again');
  });
});

/* ── The SIXTH chain: GRN -> Purchase INVOICE (added 2026-08-17) ──────────────
   Five chains closed this door; the invoicing side of the receiving chain never
   did, and `purchase-invoices.ts` contained the word "unlinked" zero times. This
   one bills MONEY rather than moving stock: an unlinked goods line invoices the
   receipt while `grn_items.invoiced_qty` stays put, so a second PI bills the same
   delivery and the supplier is paid twice. */
describe('findUnlinkedPiLines — the invoicing side of the receiving chain', () => {
  /* A fake PostgREST that serves one GRN's material codes and records what was
     asked, so "it never ran the query" cannot pass as "it found nothing". */
  const fakeSb = (codes: string[]) => {
    const calls: Array<{ table: string; col: string; val: unknown }> = [];
    return {
      calls,
      from(table: string) {
        return {
          select() { return this; },
          eq(col: string, val: unknown) {
            calls.push({ table, col, val });
            return Promise.resolve({ data: codes.map((material_code) => ({ material_code })), error: null });
          },
        };
      },
    };
  };

  const line = (itemCode: string, grnItemId: string | null, qty = 1) =>
    ({ lineRef: '0', itemCode, qty, soItemId: grnItemId });

  it('REFUSES an unlinked line billing a material that IS on the named GRN', async () => {
    const sb = fakeSb(['FOAM-A', 'FABRIC-B']);
    const out = await findUnlinkedPiLines(sb, 'grn-1', 'GRN-2608-001', [line('FOAM-A', null, 4)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.itemCode).toBe('FOAM-A');
    expect(out[0]!.parentNo).toBe('GRN-2608-001');
    // It really did read the GRN's lines, against the right column.
    expect(sb.calls).toEqual([{ table: 'grn_items', col: 'grn_id', val: 'grn-1' }]);
  });

  it('ALLOWS a PI-native service line — the reason grn_item_id is nullable', async () => {
    // Freight is not on the receipt, so it is genuinely ad-hoc. This is the
    // property that lets the guard ship without breaking normal invoicing.
    const sb = fakeSb(['FOAM-A']);
    expect(await findUnlinkedPiLines(sb, 'grn-1', 'GRN-2608-001', [line('FREIGHT', null, 1)])).toEqual([]);
  });

  it('ALLOWS a LINKED line for the same material — the cap already sees it', async () => {
    const sb = fakeSb(['FOAM-A']);
    expect(await findUnlinkedPiLines(sb, 'grn-1', 'GRN-2608-001', [line('FOAM-A', 'gi-1', 4)])).toEqual([]);
  });

  it('ALLOWS everything when the invoice names NO GRN — there is nothing to bypass', async () => {
    const sb = fakeSb(['FOAM-A']);
    expect(await findUnlinkedPiLines(sb, null, null, [line('FOAM-A', null, 4)])).toEqual([]);
    // And it does not even issue the read.
    expect(sb.calls).toEqual([]);
  });

  it('does not read the GRN at all when every line is already linked', async () => {
    const sb = fakeSb(['FOAM-A']);
    await findUnlinkedPiLines(sb, 'grn-1', 'GRN-2608-001', [line('FOAM-A', 'gi-1')]);
    expect(sb.calls).toEqual([]);
  });

  it('matches item codes case- and whitespace-insensitively', async () => {
    const sb = fakeSb(['foam-a']);
    expect(await findUnlinkedPiLines(sb, 'grn-1', 'GRN-1', [line('  FOAM-A ', null)])).toHaveLength(1);
  });
});

describe('unlinkedInvoiceResponse', () => {
  it('says the goods get PAID FOR twice — the consequence is money, not stock', () => {
    const body = unlinkedInvoiceResponse([off('FOAM-A', 4, 'GRN-2608-001')]);
    expect(body.error).toBe('unlinked_grn_lines');
    expect(body.message).toContain('Goods Receipt GRN-2608-001');
    expect(body.message).toContain('invoiced and paid for a second time');
    expect(body.message).toContain('1 line(s)');
  });

  it('tells the operator that freight and service lines are unaffected', () => {
    // Without this sentence the refusal reads as "you may not add lines", and
    // the operator's next move is to remove a legitimate charge.
    expect(unlinkedInvoiceResponse([off('FOAM-A', 1, 'GRN-1')]).message)
      .toContain('A freight or service line');
  });
});

/* The WIRING. A guard nothing calls is the failure mode this repo keeps paying
   for, and this one is being added to a 2,500-line router. */
describe('the invoice guard is wired into BOTH paths that can create such a line', () => {
  it('POST / (create, including the ?grnId= draft path)', () => {
    const create = piRouterSrc.slice(
      piRouterSrc.indexOf("purchaseInvoices.post('/', async (c)"),
      piRouterSrc.indexOf("purchaseInvoices.post('/from-grn-items'"),
    );
    expect(create.length).toBeGreaterThan(500);
    expect(create).toContain('findUnlinkedPiLines');
    expect(create).toContain('unlinkedInvoiceResponse');
  });

  it('POST /:id/items (add a line to an existing invoice)', () => {
    const add = piRouterSrc.slice(piRouterSrc.indexOf("purchaseInvoices.post('/:id/items'"));
    expect(add.length).toBeGreaterThan(500);
    expect(add).toContain('findUnlinkedPiLines');
  });

  it('the add-line path reads the parent invoice\'s grn_id, or it has no parent to check', () => {
    expect(piRouterSrc).toContain("select('id, grn_id')");
  });
});
