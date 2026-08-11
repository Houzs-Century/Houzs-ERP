/**
 * D10 — the ERP's material_code is NOT AutoCount's ItemCode.
 *
 * The write-back used to compose details with identityResolver, so "9028-1S"
 * would have been written into the licensed account book as an ItemCode. The
 * book calls that sofa "AMN-SF9028 SOFA" and has never heard of "9028-1S". On a
 * purchase order the resulting line cannot even be deleted afterwards.
 *
 * The contract these tests pin is TOTALITY, not coverage: every line resolves to
 * exactly ONE AutoCount ItemCode, or the whole document is refused with a named
 * reason and the candidates it could not choose between. A silent fallback to
 * material_code is the one behaviour that must be impossible.
 */
import { describe, expect, it } from 'vitest';
import {
  AC_ITEM_MAP_ROWS,
  ItemCodeError,
  acItemIndex,
  buildAcItemIndex,
  resolveAcItemCode,
} from './autocount-item-code';
import { AC_ITEM_MAP_TSV } from './autocount-item-map';
import { AC_SOFA_CORPUS } from './autocount-sofa-corpus';
import {
  SofaCollapseError,
  composeCreatePo,
  composeCreateSo,
  composeDetails,
  type ErpLine,
} from './autocount-writeback';

/* `location` is not decoration: a CREATE with none is refused outright, because
   AutoCount answers FK_SODTL_Location to an empty one. These cases are about
   the ITEM CODE, so every line carries a real warehouse and gets out of the
   way. */
const line = (over: Partial<ErpLine>): ErpLine => ({
  item_code: 'MISC',
  item_group: null,
  description: 'x',
  description2: null,
  qty: 1,
  unit_price_centi: 1000,
  location: 'KL',
  ...over,
} as ErpLine);

describe('the cutover map', () => {
  it('is compiled in and complete', () => {
    const idx = acItemIndex();
    expect(AC_ITEM_MAP_ROWS).toBe(1561);
    expect(idx.rows).toBe(AC_ITEM_MAP_ROWS);
    // one bucket per DISTINCT erp code; several AutoCount items may share one
    expect(idx.byErp.size).toBeGreaterThan(1300);
    expect(idx.byErp.size).toBeLessThan(AC_ITEM_MAP_ROWS);
  });

  it('carries the supplier column that makes the collapsed codes separable', () => {
    const withSupplier = AC_ITEM_MAP_TSV.split('\n')
      .filter((l) => (l.split('\t')[3] ?? '').trim().length > 0);
    expect(withSupplier.length).toBeGreaterThan(1500);
  });
});

describe('resolution is TOTAL — one ItemCode, or a named refusal', () => {
  /**
   * The measurement that decides whether "refuse" is honest or merely timid.
   *
   * Every corpus row is a line the account book really holds, so the ItemCode it
   * SHOULD resolve to is known. Three outcomes are possible and only one of them
   * is a defect:
   *   resolved to the book's own code — correct.
   *   refused                        — safe; a human is asked.
   *   resolved to a DIFFERENT code   — a wrong line in a licensed ledger. Zero.
   */
  it('never resolves a corpus line to the WRONG AutoCount item', () => {
    let correct = 0;
    const refusedAmbiguous: string[] = [];
    const refusedUnmapped: string[] = [];
    const wrong: string[] = [];
    let poLines = 0;
    let poRefused = 0;

    for (const row of AC_SOFA_CORPUS) {
      if (row.side === 'PO') poLines += 1;
      const r = resolveAcItemCode(row.erpCode, { supplierCode: row.creditorCode });
      if (!r.ok) {
        if (row.side === 'PO') poRefused += 1;
        (r.reason === 'ambiguous' ? refusedAmbiguous : refusedUnmapped)
          .push(`${row.side} ${row.erpCode}`);
      } else if (r.acItemCode !== row.acItemCode) {
        wrong.push(`${row.side} ${row.erpCode} -> ${r.acItemCode}, book holds ${row.acItemCode}`);
      } else {
        correct += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[D10 corpus] ${AC_SOFA_CORPUS.length} real sofa lines: ${correct} resolved to the code the `
      + `book holds, ${refusedAmbiguous.length} refused as ambiguous, `
      + `${refusedUnmapped.length} refused as unmapped, ${wrong.length} resolved WRONG.\n`
      + `[D10 corpus] purchase side: ${poLines} lines, ${poRefused} refused — the creditor is known there.`,
    );

    expect(wrong).toEqual([]);
    expect(refusedUnmapped).toEqual([]);
    // A PO names its creditor, so the purchase side must resolve completely.
    expect(poRefused).toBe(0);
    expect(poLines).toBeGreaterThan(100);
  });

  /**
   * The refusals are NOT timidity. ERP "9028-1S" was opened from two different
   * AutoCount items and BOTH of them appear on real sales orders in this corpus,
   * so picking either one is a coin flip that puts the wrong supplier's sofa
   * into a licensed ledger. This test fails if that stops being true — i.e. if
   * someone "fixes" the ambiguity by choosing a winner.
   */
  it('the ambiguity is real: both candidates occur in the book', () => {
    const seen = new Map<string, Set<string>>();
    for (const row of AC_SOFA_CORPUS) {
      const s = seen.get(row.erpCode) ?? new Set<string>();
      s.add(row.acItemCode);
      seen.set(row.erpCode, s);
    }
    const contested = [...seen].filter(([, acs]) => acs.size > 1);
    // eslint-disable-next-line no-console
    console.log(`[D10 ambiguity] ${contested.length} ERP sofa code(s) appear in the book under more `
      + `than one ItemCode: ${contested.map(([e, a]) => `${e} = ${[...a].join(' | ')}`).join('; ')}`);
    expect(contested.length).toBeGreaterThan(0);
    for (const [erp] of contested) {
      const r = resolveAcItemCode(erp);
      expect(r.ok, `${erp} must not be guessed`).toBe(false);
    }
  });

  it('resolves a sofa COMPARTMENT through the model base SKU', () => {
    // The compartment has no AutoCount item of its own — that is the whole of D9.
    const base = resolveAcItemCode('5526-1S');
    expect(base.ok).toBe(true);
    const comp = resolveAcItemCode('5526-1A(LHF)');
    expect(comp.ok).toBe(true);
    expect(comp.ok && comp.via).toBe('sofa-model');
    expect(comp.ok && comp.acItemCode).toBe(base.ok && base.acItemCode);
  });

  it('measures how much of the map is invertible without a supplier', () => {
    const idx = acItemIndex();
    let one = 0;
    let several = 0;
    for (const [, bucket] of idx.byErp) {
      const distinct = new Set(bucket.map((e) => e.ac));
      if (distinct.size === 1) one += 1; else several += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`[D10 inverse] ${one} ERP codes map to exactly one AutoCount item, `
      + `${several} map to several and need the supplier.`);
    expect(one + several).toBe(idx.byErp.size);
    expect(several).toBeGreaterThan(0);
  });
});

describe('REFUSAL, never a fallback to material_code', () => {
  it('refuses an ERP code the account book has never heard of', () => {
    const r = resolveAcItemCode('TOTALLY-MADE-UP-SKU');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unmapped');
    expect(!r.ok && r.detail).toContain('TOTALLY-MADE-UP-SKU');
    // the input must NOT come back out as an answer
    expect(JSON.stringify(r)).not.toContain('"acItemCode"');
  });

  it('refuses a blank item code', () => {
    const r = resolveAcItemCode('');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unmapped');
  });

  /**
   * THE REGRESSION THIS WHOLE MODULE EXISTS FOR. Before the fix, toDetails did
   * `resolve(l.item_code).acItemCode ?? l.item_code` — the ?? was the silent
   * fallback, and with the default identityResolver it fired on EVERY line. An
   * unmapped SKU therefore sailed into a create payload as its own ItemCode.
   */
  it('composeDetails THROWS on an unmapped line instead of sending the ERP code', () => {
    expect(() => composeDetails([line({ item_code: 'NOT-IN-AUTOCOUNT' })]))
      .toThrow(ItemCodeError);
    try {
      composeDetails([line({ item_code: 'NOT-IN-AUTOCOUNT' })]);
    } catch (e) {
      expect(e).toBeInstanceOf(ItemCodeError);
      expect((e as ItemCodeError).failures).toHaveLength(1);
      expect((e as ItemCodeError).failures[0].erpItemCode).toBe('NOT-IN-AUTOCOUNT');
    }
  });

  it('reports EVERY failing line at once, not just the first', () => {
    try {
      composeDetails([
        line({ item_code: 'NOPE-1' }),
        line({ item_code: 'MISC' }),
        line({ item_code: 'NOPE-2' }),
      ]);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ItemCodeError);
      const f = (e as ItemCodeError).failures;
      expect(f.map((x) => x.erpItemCode)).toEqual(['NOPE-1', 'NOPE-2']);
      // index is into the composed line list, so it points at a real row
      expect(f.every((x) => x.index >= 0)).toBe(true);
    }
  });

  it('refuses the WHOLE document — one bad line does not ship the good ones', () => {
    const good = line({ item_code: 'MISC' });
    expect(() => composeCreateSo(
      { doc_no: 'SO-9999', customer_name: 'X' } as never,
      [good, line({ item_code: 'NOPE' })],
    )).toThrow(ItemCodeError);
    // and the same document without the bad line composes fine
    const ok = composeCreateSo({ doc_no: 'SO-9999', customer_name: 'X' } as never, [good]);
    expect(ok.Details).toHaveLength(1);
    expect(ok.Details[0].ItemCode).toBe('Miscellaneous');
  });
});

describe('the supplier is the disambiguator, and only a PO has one', () => {
  /** A hand-built two-item collision, so the test does not depend on which real
   *  codes happen to collide this month. */
  const TSV = [
    'AC-FROM-A\tSHARED-CODE\tBEDFRAME\t400-A001',
    'AC-FROM-B\tSHARED-CODE\tBEDFRAME\t400-B002',
    'AC-SOLO\tSOLO-CODE\tBEDFRAME\t400-A001',
  ].join('\n');
  const index = buildAcItemIndex(TSV);

  it('refuses a collapsed code when the document names no supplier', () => {
    const r = resolveAcItemCode('SHARED-CODE', { index });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('ambiguous');
    expect(!r.ok && r.candidates).toEqual(['AC-FROM-A', 'AC-FROM-B']);
    expect(!r.ok && r.detail).toContain('names no supplier');
  });

  it('resolves the same code once the creditor is known', () => {
    expect(resolveAcItemCode('SHARED-CODE', { index, supplierCode: '400-B002' }))
      .toEqual({ ok: true, acItemCode: 'AC-FROM-B', via: 'direct' });
  });

  it('refuses — does not fall back — when the supplier matches nothing', () => {
    const r = resolveAcItemCode('SHARED-CODE', { index, supplierCode: '400-ZZZZ' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toContain('none belongs to supplier');
  });

  it('a PO passes its creditor through automatically', () => {
    const po = composeCreatePo(
      { po_number: 'PO-1', creditor_code: '400-B002', creditor_name: 'B' } as never,
      [line({ item_code: 'SHARED-CODE' })],
      { itemIndex: index },
    );
    expect(po.Details[0].ItemCode).toBe('AC-FROM-B');

    // the same PO with no creditor cannot choose, and says so
    expect(() => composeCreatePo(
      { po_number: 'PO-1', creditor_code: null, creditor_name: null } as never,
      [line({ item_code: 'SHARED-CODE' })],
      { itemIndex: index },
    )).toThrow(ItemCodeError);
  });
});

describe('a sofa document refuses before it resolves', () => {
  it('surfaces the collapse refusal, not an ItemCode error', () => {
    // A corner alone is not a build; the collapse refuses it, and that refusal
    // must not be masked by an ItemCode failure on a compartment SKU.
    expect(() => composeDetails([
      line({ item_code: '5526-CNR', item_group: 'sofa', description2: '1 + 1 (28")' }),
    ])).toThrow(SofaCollapseError);
  });

  it('a clean sofa build reaches AutoCount as ONE line with the book\'s own ItemCode', () => {
    const d2 = '1 + 1 (28") / COL: BEIGE';
    const so = composeCreateSo({ doc_no: 'SO-1', customer_name: 'X' } as never, [
      line({ item_code: '5526-1A(LHF)', item_group: 'sofa', description2: d2, unit_price_centi: 250000 }),
      line({ item_code: '5526-1A(RHF)', item_group: 'sofa', description2: d2, unit_price_centi: 0 }),
    ]);
    expect(so.Details).toHaveLength(1);
    expect(so.Details[0].ItemCode).toBe('RDS-5526 SOFA');
    expect(so.Details[0].Desc2).toBe(d2);
    expect(so.Details[0].UnitPrice).toBe(2500);
  });
});

/* The compiled CSV is a SNAPSHOT of the book on 2026-08-05. The binding table
   is this ERP's own live record of what AutoCount calls each product, and it is
   the only one of the two that GROWS. Without it every post-cutover SKU was
   refused - which refused the whole document, which meant /ensure-masters never
   ran for the very case it exists for. */
describe('the live supplier binding resolves what the cutover snapshot cannot', () => {
  test('a SKU opened after the cutover resolves through its binding', () => {
    const r = resolveAcItemCode('BRAND-NEW-SKU', {
      bindings: new Map([['BRAND-NEW-SKU', 'NB-BRANDNEW']]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('NB-BRANDNEW'); expect(r.via).toBe('binding'); }
  });

  test('and without one it is still REFUSED, never guessed from material_code', () => {
    const r = resolveAcItemCode('BRAND-NEW-SKU', {});
    expect(r.ok).toBe(false);
  });

  test('the binding WINS over the snapshot — the book can be renamed and the CSV cannot know', () => {
    /* AERO-Y04 (K) is what the 2026-08-05 CSV holds for Y04-(K). */
    const snapshot = resolveAcItemCode('Y04-(K)', {});
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.acItemCode).toBe('AERO-Y04 (K)');

    const live = resolveAcItemCode('Y04-(K)', { bindings: new Map([['Y04-(K)', 'AERO-Y04-RENAMED']]) });
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.acItemCode).toBe('AERO-Y04-RENAMED');
  });

  test('the lookup is case-insensitive on the ERP code, as every other one here is', () => {
    const r = resolveAcItemCode('brand-new-sku', { bindings: new Map([['BRAND-NEW-SKU', 'NB-BRANDNEW']]) });
    expect(r.ok).toBe(true);
  });
});
