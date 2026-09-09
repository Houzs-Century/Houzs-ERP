// The rule that decides which migrated sales-order line is corrected to the
// book's product, and what it becomes (scripts/lib/so-item-code-correction.mjs).
//
// The owner ruled on 2026-09-08: follow AutoCount, correct the sales order. The
// values below are the real ones from the 2026-09-07 incident (docs/bugs/0668,
// 0671): AutoCount's SODtlKey 165874 is HOK-2008(A) (K), which the 1,561-row
// mapping sheet turns into TRION (A) (HB STR)-(K) - and our sales-order line
// said REGAL (A)-(K).
//
// What is being defended here is not the happy path. It is the three refusals:
// a key claimed by more than one ERP row (a decomposed sofa, where
// linked_ac_dtlkey is NOT unique and a keyed repair once proposed RM 2,216,501
// of invented revenue), a target code our own pick list does not carry, and the
// money and variants never appearing in a write at all.
import { describe, expect, it } from 'vitest';

import { itemGroupForCategory, planSoItemCodeCorrections } from '../scripts/lib/so-item-code-correction.mjs';
import { makeModelOverrideIndex } from '../scripts/lib/ac-model-override.mjs';

const edge = (over = {}) => ({ DocNo: 'PO-010095', DtlKey: 917739, FromDocNo: 'SO-002558', FromSODtlKey: 165874, ...over });
const bookLine = (over = {}) => ({ docNo: 'SO-002558', dtlKey: 165874, itemKey: 'HOK-2008(A) (K)', qty: '1.0000', unitPrice: '0.0000', subTotal: '0.00', ...over });
const erpLine = (over = {}) => ({
  id: 'so-item-1', doc_no: 'HC-SO-002558', line_no: 1, item_code: 'REGAL (A)-(K)', item_group: 'bedframe',
  description: 'Regal (A) King', qty: 1, unit_price_sen: 250000, total_sen: 250000, unit_cost_sen: 0,
  stock_status: 'PENDING', variants: { colourId: 'PC151-01' }, custom_specials: null,
  debtor_name: 'A Customer', ...over,
});

const world = ({ book = bookLine(), erp = [erpLine()], products = [{ code: 'TRION (A) (HB STR)-(K)', name: 'Trion (A) HB Straight King' }], overrideIndex = null } = {}) => ({
  edges: [edge()],
  bookSoByDtl: new Map([['165874', book]]),
  acMapByCode: new Map([['HOK-2008(A) (K)', { erp: 'TRION (A) (HB STR)-(K)', cat: 'BEDFRAME' }]]),
  erpRowsByDtl: new Map(erp.length ? [['165874', erp]] : []),
  productByCode: new Map(products.map((p) => [p.code.toUpperCase(), p])),
  overrideIndex,
});

describe('the sales-order item-code correction rule', () => {
  it('corrects the line to the book product, resolved through our own pick list', () => {
    const { plan, refused, counts } = planSoItemCodeCorrections(world());
    expect(refused).toHaveLength(0);
    expect(counts.agree).toBe(0);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      id: 'so-item-1', docNo: 'HC-SO-002558', dtlKey: '165874',
      fromCode: 'REGAL (A)-(K)', toCode: 'TRION (A) (HB STR)-(K)',
      fromGroup: 'bedframe', toGroup: 'bedframe',
      toDescription: 'Trion (A) HB Straight King',
    });
  });

  /* THE POINT OF THE WHOLE EXERCISE. A wrong price on a customer's order is
     worse than a wrong product name, so the plan must carry the money it read
     and must never propose a new one. */
  it('carries the line money unchanged and proposes no new price or quantity', () => {
    const { plan } = planSoItemCodeCorrections(world());
    expect(plan[0]).toMatchObject({ qty: 1, unitPriceSen: 250000, totalSen: 250000 });
    expect(Object.keys(plan[0])).not.toContain('toUnitPriceSen');
    expect(Object.keys(plan[0])).not.toContain('toQty');
    expect(Object.keys(plan[0])).not.toContain('toTotalSen');
  });

  it('carries variants and specials unchanged and proposes no new ones', () => {
    const { plan } = planSoItemCodeCorrections(world());
    expect(plan[0].variants).toEqual({ colourId: 'PC151-01' });
    expect(plan[0].customSpecials).toBeNull();
    expect(Object.keys(plan[0])).not.toContain('toVariants');
    expect(Object.keys(plan[0])).not.toContain('toCustomSpecials');
  });

  it('leaves a line that already names the book product alone', () => {
    const { plan, counts } = planSoItemCodeCorrections(world({ erp: [erpLine({ item_code: 'trion (a)  (hb str)-(k) ' })] }));
    expect(plan).toHaveLength(0);
    expect(counts.agree).toBe(1);
  });

  /* linked_ac_dtlkey is NOT unique: one AutoCount sofa line is one ERP row PER
     COMPARTMENT (docs/bugs/0673). The book line's own code is not a
     compartment's code, so this is a person's decision, never a write. */
  it('REFUSES a key claimed by more than one ERP row', () => {
    const { plan, refused, counts } = planSoItemCodeCorrections(world({
      erp: [erpLine(), erpLine({ id: 'so-item-2', line_no: 2 })],
    }));
    expect(plan).toHaveLength(0);
    expect(counts.decomposed).toBe(1);
    expect(refused[0]).toMatchObject({ why: 'decomposed', rows: 2 });
  });

  it('REFUSES a target code our own pick list does not carry', () => {
    const { plan, refused, counts } = planSoItemCodeCorrections(world({ products: [] }));
    expect(plan).toHaveLength(0);
    expect(counts.noProduct).toBe(1);
    expect(refused[0]).toMatchObject({ why: 'noProduct', wanted: 'TRION (A) (HB STR)-(K)' });
  });

  it('says nothing when the AutoCount code is not in the mapping sheet', () => {
    const w = world();
    w.acMapByCode = new Map();
    const { plan, refused, counts } = planSoItemCodeCorrections(w);
    expect(plan).toHaveLength(0);
    expect(refused).toHaveLength(0);
    expect(counts.unmapped).toBe(1);
  });

  it('says nothing when the AutoCount line is not in this snapshot', () => {
    const w = world();
    w.bookSoByDtl = new Map();
    const { plan, counts } = planSoItemCodeCorrections(w);
    expect(plan).toHaveLength(0);
    expect(counts.notInBook).toBe(1);
  });

  /* One sales-order line can feed several purchase-order lines, so the same
     FromSODtlKey arrives on more than one edge. Correcting it twice would be a
     second UPDATE of a row the first already moved. */
  it('corrects a line once even when several PO lines name it', () => {
    const w = world();
    w.edges = [edge(), edge({ DtlKey: 917741 }), edge({ DtlKey: 917743 })];
    const { plan, counts } = planSoItemCodeCorrections(w);
    expect(plan).toHaveLength(1);
    expect(counts.edges).toBe(1);
  });

  /* item_group follows the mapping sheet's CATEGORY, not the ERP row, because
     isHardBoundLine reads the group and a stale one keeps a bed pooled. */
  it('takes item_group from the mapping sheet category', () => {
    const w = world({ products: [{ code: 'SQUARE PILLOW', name: 'Square Pillow' }] });
    w.acMapByCode = new Map([['AMN-SQUARE PILLOW', { erp: 'SQUARE PILLOW', cat: 'ACC' }]]);
    w.bookSoByDtl = new Map([['165874', bookLine({ itemKey: 'AMN-SQUARE PILLOW' })]]);
    w.erpRowsByDtl = new Map([['165874', [erpLine({ item_code: 'AMN-SOFA PILLOW', item_group: 'sofa' })]]]);
    const { plan } = planSoItemCodeCorrections(w);
    expect(plan[0]).toMatchObject({ fromGroup: 'sofa', toGroup: 'accessory', toCode: 'SQUARE PILLOW' });
  });

  it('maps every category the importer maps, and falls back to others', () => {
    expect(itemGroupForCategory('BEDFRAME')).toBe('bedframe');
    expect(itemGroupForCategory('acc')).toBe('accessory');
    expect(itemGroupForCategory('SOFA')).toBe('sofa');
    expect(itemGroupForCategory('TRANS')).toBe('service');
    expect(itemGroupForCategory('')).toBe('others');
    expect(itemGroupForCategory(undefined)).toBe('others');
  });

  /* ── THE OWNER'S OWN DECISION IS NOT A DEFECT ─────────────────────────────
     Measured on prod run 34258437955: with POPULATION=all this planner named
     exactly TWO corrections and one of them was HC-SO-011657, where the ERP
     holds model 8030 against the book's TNS-9838 DB because he ruled
     「那就放8030 daybed把」. Applying it would have silently undone his ruling. */
  it('leaves a DECLARED owner decision alone instead of undoing it', () => {
    const overrideIndex = makeModelOverrideIndex([
      { docs: ['HC-SO-002558'], model: '9999', modelOverride: { book: 'HOK-2008(A) (K)', by: 'owner', on: '2026-09-08' } },
    ]);
    const { plan, refused, counts } = planSoItemCodeCorrections(world({
      erp: [erpLine({ item_code: '9999-STOOL' })],
      overrideIndex,
    }));
    expect(plan).toHaveLength(0);
    expect(counts.ownerDecided).toBe(1);
    expect(refused[0].why).toBe('ownerDecided');
    expect(refused[0].detail).toContain("OWNER'S OWN DECISION");
  });

  it('THE EXPIRY — a declaration whose book model no longer matches does NOT protect the row', () => {
    const overrideIndex = makeModelOverrideIndex([
      { docs: ['HC-SO-002558'], model: '9999', modelOverride: { book: 'HOK-7777 (K)', by: 'owner', on: '2026-09-08' } },
    ]);
    const { plan, counts } = planSoItemCodeCorrections(world({
      erp: [erpLine({ item_code: '9999-STOOL' })],
      overrideIndex,
    }));
    expect(counts.ownerDecided).toBe(0);
    expect(plan).toHaveLength(1);
  });

  it('an OMITTED overrideIndex throws — a deciding parameter is never optional', () => {
    const w = world();
    delete w.overrideIndex;
    expect(() => planSoItemCodeCorrections(w)).toThrow(/overrideIndex/);
  });
});
