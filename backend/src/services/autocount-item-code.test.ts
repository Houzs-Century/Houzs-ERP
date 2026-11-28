import { describe, expect, it, test } from 'vitest';
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
  MissingCreditorError,
  SofaCollapseError,
  composeCreatePo,
  composeCreateSo,
  composeDetails,
  type ErpLine,
} from './autocount-writeback';

const line = (over: Partial<ErpLine>): ErpLine => ({
  item_code: 'MISC',
  item_group: null,
  description: 'x',
  description2: null,
  qty: 1,
  unit_price_sen: 1000,
  location: 'KL',
  ...over,
} as ErpLine);

describe('the cutover map', () => {
  it('is compiled in and complete', () => {
    const idx = acItemIndex();
    // 1,561 at the 2026-08-05 cut; +16 on 2026-08-28 (the codes the owner
    // opened in the book since — DL-CLASSIC mattresses, HOK-1056 -> FLAT,
    // 5562 sofa, RC charges).
    expect(AC_ITEM_MAP_ROWS).toBe(1577);
    expect(idx.rows).toBe(AC_ITEM_MAP_ROWS);
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
  it('never resolves a corpus line to the WRONG AutoCount item', () => {
    let correct = 0;
    const refusedAmbiguous: string[] = [];
    const refusedUnmapped: string[] = [];
    const wrong: string[] = [];
    let poLines = 0;
    let poRefused = 0;
    let byChoice = 0;

    for (const row of AC_SOFA_CORPUS) {
      if (row.side === 'PO') poLines += 1;
      const r = resolveAcItemCode(row.erpCode, { supplierCode: row.creditorCode });
      if (r.ok && r.via === 'erp-canonical') { byChoice += 1; continue; }
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
      + `[D10 corpus] purchase side: ${poLines} lines, ${poRefused} refused — the creditor is known there.\n`
      + `[D10 corpus] ${byChoice} line(s) sit on a code with a standing choice — a NEW document `
      + 'uses the canonical item; these keep theirs because an edit omits the ItemCode.',
    );

    expect(wrong).toEqual([]);
    expect(refusedUnmapped).toEqual([]);
    expect(byChoice).toBeGreaterThan(0);
    expect(poRefused).toBe(0);
    expect(poLines).toBeGreaterThan(100);
  });

  /**
   * The ambiguity is REAL, and it is why a coin flip was never acceptable: ERP
   * "9028-1S" was opened from two different AutoCount items and BOTH appear on
   * real sales orders here. Measured 2026-08-13 — 9028: 64 DorsettLoft / 40
   * Armani, 9058: 72 / 18. No single existing item is right for more than about
   * 70% of them.
   *
   * The answer is therefore NOT to pick one of the two. Owner 2026-08-13: one
   * canonical item per model, named as the ERP names it, opened by
   * /ensure-masters — so the brand lives on the purchase order, where it is
   * actually known. This test holds the line that made that necessary: every
   * contested code must resolve to a DECLARED canonical item, never to one of
   * the brand items it could not choose between.
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
    for (const [erp, acs] of contested) {
      const r = resolveAcItemCode(erp);
      if (!r.ok) continue;
      if (r.via === 'same-name' || r.via === 'preferred-supplier') continue;
      expect(r.via, `${erp} must not be guessed`).toBe('erp-canonical');
      expect([...acs], `${erp} resolved to one of the brand items it cannot choose between`)
        .not.toContain(r.acItemCode);
      expect(r.acItemCode, `${erp} did not fall back to its own code`).toBe(erp);
    }
  });

  it('a sofa COMPARTMENT resolves to ITSELF, not to the model', () => {
    const base = resolveAcItemCode('5526-1S');
    expect(base.ok).toBe(true);
    const comp = resolveAcItemCode('5526-1A(LHF)');
    expect(comp.ok).toBe(true);
    if (comp.ok) { expect(comp.acItemCode).toBe('5526-1A(LHF)'); expect(comp.via).toBe('erp-canonical'); }
    return;
    expect(comp).toEqual(base);
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

describe('an unknown code is OPENED under its own name, not refused', () => {
  it('resolves an ERP code the account book has never heard of', () => {
    const r = resolveAcItemCode('TOTALLY-MADE-UP-SKU');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('TOTALLY-MADE-UP-SKU'); expect(r.via).toBe('erp-canonical'); }
  });

  it('refuses a blank item code', () => {
    const r = resolveAcItemCode('');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unmapped');
  });

  it('an unmapped line is sent under its own code, and opened', () => {
    const { details } = composeDetails([line({ item_code: 'NOT-IN-AUTOCOUNT' })]);
    expect(details).toHaveLength(1);
    expect(details[0].ItemCode).toBe('NOT-IN-AUTOCOUNT');
  });

  it('a MAPPED code is never sent as itself — that would be the old bug', () => {
    const { details } = composeDetails([line({ item_code: 'MISC' })]);
    expect(details[0].ItemCode).toBe('Miscellaneous');
    expect(details[0].ItemCode).not.toBe('MISC');
  });

  it('every line resolves — one unknown code no longer sinks the document', () => {
    const { details } = composeDetails([
      line({ item_code: 'NOPE-1' }),
      line({ item_code: 'MISC' }),
      line({ item_code: 'NOPE-2' }),
    ]);
    expect(details.map((d) => d.ItemCode)).toEqual(['NOPE-1', 'Miscellaneous', 'NOPE-2']);
  });

  it('a document mixing known and unknown codes ships whole', () => {
    const good = line({ item_code: 'MISC' });
    const p = composeCreateSo(
      { doc_no: 'SO-9999', customer_name: 'X' } as never,
      [good, line({ item_code: 'NOPE' })],
      'KINGSLEY',
      null,
      [],
    );
    expect(p.Details.map((d) => d.ItemCode)).toEqual(['Miscellaneous', 'NOPE']);
  });
});

describe('the supplier is the disambiguator, and only a PO has one', () => {
  const TSV = [
    'AC-FROM-A\tSHARED-CODE\tBEDFRAME\t400-A001',
    'AC-FROM-B\tSHARED-CODE\tBEDFRAME\t400-B002',
    'AC-SOLO\tSOLO-CODE\tBEDFRAME\t400-A001',
  ].join('\n');
  const index = buildAcItemIndex(TSV);

  it('with no supplier and no preference to apply, it falls back to our own code', () => {
    const r = resolveAcItemCode('SHARED-CODE', { index });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('SHARED-CODE'); expect(r.via).toBe('erp-canonical'); }
  });

  it('resolves the same code once the creditor is known', () => {
    expect(resolveAcItemCode('SHARED-CODE', { index, supplierCode: '400-B002' }))
      .toEqual({ ok: true, acItemCode: 'AC-FROM-B', via: 'direct' });
  });

  it('a PO whose creditor holds none of the candidates is still REFUSED', () => {
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

    const { details } = composeDetails([line({ item_code: 'SHARED-CODE' })], {
      itemIndex: index, supplierCode: null,
    });
    expect(details[0].ItemCode).toBe('SHARED-CODE');
    expect(() => composeCreatePo(
      { po_number: 'PO-1', creditor_code: null, creditor_name: null } as never,
      [line({ item_code: 'SHARED-CODE' })],
      { itemIndex: index },
    )).toThrow(MissingCreditorError);
  });
});

/* Owner 2026-08-13: a NEW order sends one AutoCount line per ERP line. Only a
   build the account book ALREADY holds as a single line still folds, and it
   says so itself — its compartments share one DtlKey. See
   autocount-sofa-collapse.test.ts for the shape rule; these pin what the
   composer does with each shape. */
describe('a sofa CREATE sends one line per compartment', () => {
  it('a corner alone is no longer a refusal — it is simply its own line', () => {
    const { details } = composeDetails([
      line({ item_code: '5526-CNR', item_group: 'sofa', description2: '1 + 1 (28")' }),
    ]);
    expect(details).toHaveLength(1);
    expect(details[0].ItemCode).toBe('5526-CNR');
  });

  it('a clean build reaches AutoCount as TWO lines, each under its own code', () => {
    const d2 = '1 + 1 (28") / COL: BEIGE';
    const so = composeCreateSo({ doc_no: 'SO-1', customer_name: 'X' } as never, [
      line({ item_code: '5526-1A(LHF)', item_group: 'sofa', description2: d2, unit_price_sen: 250000 }),
      line({ item_code: '5526-1A(RHF)', item_group: 'sofa', description2: d2, unit_price_sen: 0 }),
    ], 'KINGSLEY', null, []);
    expect(so.Details).toHaveLength(2);
    expect(so.Details.map((d) => d.ItemCode)).toEqual(['5526-1A(LHF)', '5526-1A(RHF)']);
    expect(so.Details.map((d) => d.Desc2)).toEqual([d2, d2]);
    expect(so.Details.map((d) => d.UnitPrice)).toEqual([2500, 0]);
  });

  it('the SAME build already folded in the book stays ONE line, on the book\'s item', () => {
    const d2 = '1 + 1 (28") / COL: BEIGE';
    const { details } = composeDetails([
      line({ item_code: '5526-1A(LHF)', item_group: 'sofa', description2: d2, unit_price_sen: 250000, linked_ac_dtlkey: 501 }),
      line({ item_code: '5526-1A(RHF)', item_group: 'sofa', description2: d2, unit_price_sen: 0, linked_ac_dtlkey: 501 }),
    ]);
    expect(details).toHaveLength(1);
    expect(details[0].ItemCode).toBe('RDS-5526 SOFA');
    expect(details[0].Desc2).toBe(d2);
    expect(details[0].UnitPrice).toBe(2500);
  });
});

describe('the live supplier binding resolves what the cutover snapshot cannot', () => {
  test('a SKU opened after the cutover resolves through its binding', () => {
    const r = resolveAcItemCode('BRAND-NEW-SKU', {
      bindings: new Map([['BRAND-NEW-SKU', 'NB-BRANDNEW']]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('NB-BRANDNEW'); expect(r.via).toBe('binding'); }
  });

  test('and without one it now resolves to itself, which is what gets opened', () => {
    const r = resolveAcItemCode('BRAND-NEW-SKU', {});
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('BRAND-NEW-SKU'); expect(r.via).toBe('erp-canonical'); }
  });

  test('the binding WINS over the snapshot — the book can be renamed and the CSV cannot know', () => {
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

/* Owner's chain, 2026-08-13, for an ERP code the cutover left pointing at
   several AutoCount items and a document that cannot say which:

     1. one candidate            -> it
     2. the document's creditor  -> that supplier's item
     3. a candidate NAMED like the ERP code -> it
     4. HOK, then NB
     5. our own code, opened by /ensure-masters

   Step 2 almost never fires on a sales order: the purchase order does not exist
   yet when the order is written back ("开 SO 的时候 PO 还没开"), which is the
   whole reason the rest of the chain has to be total. */
describe("the owner's chain for a code no sales order can disambiguate", () => {
  test('3 — a candidate named like the ERP code wins, even over alphabet', () => {
    const r = resolveAcItemCode('HB709NL', {});
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('HB709NL'); expect(r.via).toBe('same-name'); }
  });

  test('3 — the mis-mapped Winter merge is HEALED: ARCTIC resolves to its own code', () => {
    /* Until 2026-08-29 this test exercised rule 3 on broken data: the mapping
       pointed 'DL-CS2 ARCTIC DREAM (K)' at the 30-char-truncated Winter name,
       so the ERP code carried two candidate rows and the same-name match had
       to beat the alphabetically-first mis-mapped one. docs/bugs/0567 rebuilt
       those 17 rows — each family owns its own name again, no ERP code in the
       healed map has a same-named row that is not alphabetically first, and
       the wrong-alphabet scenario cannot be built from committed data any
       more. Rule 3's positive case stays pinned by the HB709NL test above;
       THIS test now pins the healed state instead: the ARCTIC family resolves
       to itself, one candidate, no merge.

       2026-08-30: the ERP side of the row was renamed to the family long name
       (scripts/rename-new-code-rows.mjs, this PR), so the INPUT here follows
       it. The pinned ANSWER does not move — the book's Item master holds
       'DL-CS2 ARCTIC DREAM (K)', measured live (no MATT in the AC code). */
    const r = resolveAcItemCode('DUNLOPILLO COOLSILK 2.0 ARCTIC DREAM MATT (K)', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.acItemCode).toBe('DL-CS2 ARCTIC DREAM (K)');
    }
  });

  test('4 — HOK wins where it is one of the candidates', () => {
    const r = resolveAcItemCode('SQUARE PILLOW', {});
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('HOK-SQUARE PILLOW'); expect(r.via).toBe('preferred-supplier'); }
  });

  test('4 — NB is the fallback when there is no HOK', () => {
    const hits = [...acItemIndex().byErp.entries()].filter(([, v]) =>
      v.length > 1
      && !v.some((e) => e.ac.toUpperCase().startsWith('HOK-'))
      && v.some((e) => e.ac.toUpperCase().startsWith('NB-')));
    expect(hits.length).toBeGreaterThan(0);
    for (const [erp] of hits) {
      const r = resolveAcItemCode(erp, {});
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.acItemCode.toUpperCase().startsWith('NB-')).toBe(true);
    }
  });

  test('5 — neither HOK nor NB: our own code, never a coin flip between brands', () => {
    for (const erp of ['9028-1S', '9058-1S', '5152-1S', '5080-1S', 'GINA-(SS)', 'SGABELLO']) {
      const r = resolveAcItemCode(erp, {});
      expect(r.ok, erp).toBe(true);
      if (r.ok) {
        expect(r.acItemCode, erp).toBe(erp);
        expect(r.via, erp).toBe('erp-canonical');
      }
    }
  });

  test('5 — a code the book has NEVER held resolves instead of refusing the order', () => {
    const r = resolveAcItemCode('SOME-BRAND-NEW-CODE-9999', {});
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('SOME-BRAND-NEW-CODE-9999'); expect(r.via).toBe('erp-canonical'); }
  });

  test('each sofa COMPARTMENT of a new order carries its own code', () => {
    for (const c of ['9028-1A(LHF)', '9028-2A(RHF)']) {
      const r = resolveAcItemCode(c, {});
      expect(r.ok, c).toBe(true);
      if (r.ok) { expect(r.acItemCode, c).toBe(c); expect(r.via, c).toBe('erp-canonical'); }
    }
  });

  test('2 — a PURCHASE ORDER still follows its own creditor, ahead of all of this', () => {
    const armani = resolveAcItemCode('9028-1S', { supplierCode: '400-A004' });
    expect(armani.ok).toBe(true);
    if (armani.ok) { expect(armani.acItemCode).toBe('AMN-SF9028 SOFA'); expect(armani.via).not.toBe('erp-canonical'); }
  });

  test('a GOOD binding still wins over the whole chain — an operator said so', () => {
    const r = resolveAcItemCode('9028-1S', { bindings: new Map([['9028-1S', 'AMN-SF9028 SOFA']]) });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('AMN-SF9028 SOFA'); expect(r.via).toBe('binding'); }
  });

  test('a WRONG binding is ignored, not obeyed and not fatal', () => {
    const r = resolveAcItemCode('9028-1S', { bindings: new Map([['9028-1S', 'AMN-SF9028 SOFA 1S']]) });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.acItemCode).toBe('9028-1S'); expect(r.via).toBe('erp-canonical'); }
  });

  test('an empty code is still refused — the one thing with no answer', () => {
    expect(resolveAcItemCode('', {}).ok).toBe(false);
    expect(resolveAcItemCode('   ', {}).ok).toBe(false);
  });
});
