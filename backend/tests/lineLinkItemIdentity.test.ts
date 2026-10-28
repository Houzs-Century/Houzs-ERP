/* The RULE behind docs/bugs/0672 site 15's twelve guards.
 *
 * `keyWithoutIdentityGuards.test.mjs` pins that each call site APPLIES the
 * rule — a call-site population is what a unit test cannot see. This file pins
 * that the rule is RIGHT: what it accepts, what it refuses, and (the two that
 * actually matter) that it refuses rather than shrugs when identity cannot be
 * established at all.
 */
import { describe, expect, it } from 'vitest';
import { assertLinkedLineItemsMatch, lineLinkItemMismatch, normLinkItemCode } from '../src/scm/lib/line-link-item-identity';

const src = (pairs: Array<[string, string | null]>) => new Map<string, string | null>(pairs);
const LBL = { source: 'Delivery Order line' };

describe('normLinkItemCode — the same normalisation as soLinkItemMismatch and normItemCode', () => {
  it('trims, upper-cases and collapses inner whitespace', () => {
    expect(normLinkItemCode('  regal-2s  ')).toBe('REGAL-2S');
    expect(normLinkItemCode('REGAL   2S')).toBe('REGAL 2S');
  });

  it('maps null, undefined and blank to the same empty string', () => {
    expect(normLinkItemCode(null)).toBe('');
    expect(normLinkItemCode(undefined)).toBe('');
    expect(normLinkItemCode('   ')).toBe('');
  });
});

describe('lineLinkItemMismatch', () => {
  it('accepts a link whose two sides name the same product', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }],
      src([['do-1', 'REGAL-2S']]),
      LBL,
    )).toBeNull();
  });

  it('accepts a difference that is only formatting', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: ' regal-2s ' }],
      src([['do-1', 'REGAL-2S']]),
      LBL,
    )).toBeNull();
  });

  /* The real shape of the bug: REGAL bound to TRION. Both rows exist, the
     foreign key is valid, nothing dangles. */
  it('refuses a link whose source names a different product', () => {
    const out = lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }],
      src([['do-1', 'TRION-2S']]),
      LBL,
    );
    expect(out?.error).toBe('link_material_mismatch');
    expect(out?.itemCode).toBe('REGAL-2S');
    expect(out?.sourceItemCode).toBe('TRION-2S');
    expect(out?.linkId).toBe('do-1');
  });

  it('names both products and the source document type in the reason', () => {
    const out = lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }],
      src([['do-1', 'TRION-2S']]),
      { source: 'Goods Receipt line' },
    );
    expect(out?.reason).toContain('REGAL-2S');
    expect(out?.reason).toContain('TRION-2S');
    expect(out?.reason).toContain('Goods Receipt line');
  });

  it('ignores an unlinked line — a manual line is not this rule\'s business', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: '', itemCode: 'ANYTHING' }],
      src([]),
      LBL,
    )).toBeNull();
  });

  /* THE TWO THAT MATTER. "I could not establish identity" must not be spelled
     the same way as "identity is fine" — that is the false negative the whole
     bug class is made of. */
  it('REFUSES a link whose source row is not in the map at all', () => {
    const out = lineLinkItemMismatch(
      [{ linkId: 'do-ghost', itemCode: 'REGAL-2S' }],
      src([['do-1', 'REGAL-2S']]),
      LBL,
    );
    expect(out?.error).toBe('link_material_mismatch');
    expect(out?.sourceItemCode).toBeNull();
    expect(out?.reason).toContain('could not be read back');
  });

  it('REFUSES when either side carries a blank item code', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }], src([['do-1', null]]), LBL,
    )?.error).toBe('link_material_mismatch');
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: null }], src([['do-1', 'REGAL-2S']]), LBL,
    )?.error).toBe('link_material_mismatch');
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: '  ' }], src([['do-1', '  ']]), LBL,
    )?.error).toBe('link_material_mismatch');
  });

  it('reports the FIRST offender and does not stop at the first good line', () => {
    const out = lineLinkItemMismatch(
      [
        { linkId: 'do-1', itemCode: 'REGAL-2S' },
        { linkId: 'do-2', itemCode: 'REGAL-3S' },
        { linkId: 'do-3', itemCode: 'REGAL-CNR' },
      ],
      src([['do-1', 'REGAL-2S'], ['do-2', 'TRION-3S'], ['do-3', 'ELSE']]),
      LBL,
    );
    expect(out?.linkId).toBe('do-2');
  });

  /* A sofa is one model decomposed into compartments, each its own ERP line
     with its own code. The rule compares the LINE's code, so the compartments
     of one order pass individually and a compartment bound to another model's
     compartment does not. */
  it('accepts a sofa\'s compartments and refuses one crossed with another model', () => {
    expect(lineLinkItemMismatch(
      [
        { linkId: 'so-1', itemCode: 'PC151-1S' },
        { linkId: 'so-2', itemCode: 'PC151-CNR' },
      ],
      src([['so-1', 'PC151-1S'], ['so-2', 'PC151-CNR']]),
      { source: 'Sales Order line' },
    )).toBeNull();

    expect(lineLinkItemMismatch(
      [{ linkId: 'so-2', itemCode: 'PC151-CNR' }],
      src([['so-2', 'PC160-CNR']]),
      { source: 'Sales Order line' },
    )?.error).toBe('link_material_mismatch');
  });
});

/* THE READ HALF. The block above pins the RULE; nothing pinned the function that
   goes and gets the rows for it, and that half is where a guard fails silently:
   it decides which table is read, whether the read is batched, and — the one
   that has cost this repo money before — what happens when the read ERRORS.
   Ported from the v2 branch, which wrote them against its own second copy of
   this rule, checkInvoiceSourceItemIdentity; that copy is gone and the
   assertions are re-pointed here, at the one home. */
type SeenRead = { table?: string; select?: string; ids?: string[] };
function fakeSb(rows: Array<{ id: string; item_code: string | null }>, opts: { error?: string } = {}) {
  const seen: SeenRead = {};
  const api = {
    seen,
    from(table: string) { seen.table = table; return api; },
    select(cols: string) { seen.select = cols; return api; },
    in(_col: string, ids: string[]) {
      seen.ids = ids;
      return Promise.resolve(opts.error ? { data: null, error: { message: opts.error } } : { data: rows, error: null });
    },
  };
  return api;
}

const DO_LINE = { id: 'do-line-1', item_code: 'REGAL-KING' };

describe('assertLinkedLineItemsMatch — the guard, read included', () => {
  it('does nothing and takes no read when no line carries a link', async () => {
    const sb = fakeSb([]);
    expect(await assertLinkedLineItemsMatch(sb, 'delivery_order_items', [{ linkId: null, itemCode: 'X' }], LBL))
      .toEqual({ ok: true });
    expect(sb.seen.table).toBeUndefined();
  });

  it('reads the table it was given, and only id + item_code from it', async () => {
    const sb = fakeSb([DO_LINE]);
    await assertLinkedLineItemsMatch(sb, 'delivery_order_items', [{ linkId: 'do-line-1', itemCode: 'REGAL-KING' }], LBL);
    expect(sb.seen.table).toBe('delivery_order_items');
    expect(sb.seen.select).toBe('id, item_code');
  });

  it('reads grn_items when the purchase chain asks', async () => {
    const sb = fakeSb([{ id: 'gr-line-1', item_code: 'TRION-QUEEN' }]);
    await assertLinkedLineItemsMatch(sb, 'grn_items', [{ linkId: 'gr-line-1', itemCode: 'TRION-QUEEN' }], { source: 'Goods Receipt line' });
    expect(sb.seen.table).toBe('grn_items');
  });

  it('refuses a cross-product bind with 409', async () => {
    const r = await assertLinkedLineItemsMatch(fakeSb([DO_LINE]), 'delivery_order_items', [{ linkId: 'do-line-1', itemCode: 'TRION-QUEEN' }], LBL);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(409);
  });

  /* A guard that answers 'clean' when its read failed is the defect wearing the
     guard's clothes. checkSiReopenOverRemaining paid for this once already. */
  it('FAILS CLOSED — a failed read is a 503, never a pass', async () => {
    const r = await assertLinkedLineItemsMatch(fakeSb([], { error: 'connection reset' }), 'delivery_order_items', [{ linkId: 'do-line-1', itemCode: 'REGAL-KING' }], LBL);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(503);
    expect(r.ok === false && (r.body as { error: string }).error).toBe('link_identity_unavailable');
  });

  it('de-duplicates the ids it asks for', async () => {
    const sb = fakeSb([DO_LINE]);
    await assertLinkedLineItemsMatch(sb, 'delivery_order_items', [
      { linkId: 'do-line-1', itemCode: 'REGAL-KING' },
      { linkId: 'do-line-1', itemCode: 'REGAL-KING' },
    ], LBL);
    expect(sb.seen.ids).toEqual(['do-line-1']);
  });
});
