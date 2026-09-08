/* The write-time refusal that stops an AutoCount importer inventing an internal
   item code, plus the property that makes it worth having: BOTH importers must
   actually consult it before they write.

   Bought on 2026-08-31. `HOK-5540 SOFA` was mapped to `5540-1S` in
   data/autocount-erp-mapping-1561.csv, a code no scm.mfg_products row carries —
   the ERP spells that sofa `8030-*`, which is what SOFA_MODEL_ALIAS says and
   what every sales order already used. The importers' silent fallback
   (`codeSet.has(ph) ? ph : l.erp`) wrote the raw mapped code instead, and 31
   production document lines ended up carrying a code the catalog does not know.

   Nothing failed. item_code is plain text with no foreign key to
   scm.mfg_products, so the only gate that could ever have caught this is the
   importer refusing to write — which is what these tests pin. */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasFoldsForCatalog, aliasedCode, catalogPredicate, nonCatalogRefs, formatNonCatalogRefusal } from '../scripts/lib/catalog-code-guard.mjs';
import { SOFA_MODEL_ALIAS } from '../scripts/lib/parse-sofa.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, '..', 'scripts');
const read = (p) => fs.readFileSync(path.join(SCRIPTS, p), 'utf8');

/** Every WRITER that resolves a book ItemCode through the mapping CSV and then
 *  writes an item_code. All three fell back silently; all three must refuse.
 *
 *  `topup-ac-po-lines.mjs` was added on 2026-09-08 and it is the reason this
 *  list is not called IMPORTERS any more. It is not an importer — it never
 *  creates a document — but it resolves the same CSV, carries the same silent
 *  fallback verbatim (`const code = codeSet.has(ph.toUpperCase()) ? ph : r.erp`)
 *  and INSERTs item_code rows, so every argument in this file's header applies
 *  to it unchanged. Being the odd one out is exactly what let it read the
 *  catalogue with the UNFOLDED code and conclude that `HOK-5536 SOFA` was not a
 *  sofa — four purchase orders were withheld on a disagreement the alias table
 *  had already settled. A membership rule that says "importer" would have kept
 *  it out again; the rule is "writes an item_code from the mapping CSV".
 *
 *  `reshape-migrated-grns.mjs` joined on 2026-09-08 for the same reason
 *  `topup-ac-po-lines.mjs` did, one bug later. It is not an importer either — it
 *  rewrites documents the migration already carried — but its unattributed arm
 *  (`const code = poi ? poi.item_code : i.book.itemKey`) resolved nothing at all
 *  and wrote AutoCount's raw ItemCode onto company-1 receipt lines. It builds a
 *  whole plan and then writes it, so the exiting refusal is the right shape for
 *  it. `repair-migrated-grn-item-codes.mjs` is deliberately NOT here; see the
 *  block at the bottom of this file for the property it carries instead. */
const CSV_ITEM_CODE_WRITERS = [
  'import-ac-outstanding-po.mjs', 'import-ac-so-linked-pos.mjs', 'topup-ac-po-lines.mjs',
  'reshape-migrated-grns.mjs',
];

/** The repair that reads the same CSV and writes the same column, and whose
 *  refusal is to LEAVE A ROW rather than to stop. It has no plan to abandon: the
 *  rows exist already, and exiting on one untranslatable line would withhold the
 *  repair from every other. So the property it must carry is stronger than the
 *  exit — a code the catalogue lacks can never enter the write set at all. */
const CSV_ITEM_CODE_REPAIRS = ['repair-migrated-grn-item-codes.mjs'];

describe('catalog-code-guard', () => {
  test('a code the catalog carries passes, in any case', () => {
    const exists = catalogPredicate(['8030-1S', '9028-1S']);
    expect(nonCatalogRefs([{ code: '8030-1S' }, { code: ' 9028-1s ' }], exists)).toEqual([]);
  });

  test('the exact orphan that shipped is refused, and the aliased code is not', () => {
    const exists = catalogPredicate(['8030-1S', '8030-1A(LHF)', '9028-1S', '9058-1S']);
    const bad = nonCatalogRefs([
      { code: '5540-1S', doc: 'HC-PO-010087', acCode: 'HOK-5540 SOFA' },
      { code: '8030-1S', doc: 'HC-PO-010087', acCode: 'HOK-5540 SOFA' },
    ], exists);
    expect(bad).toHaveLength(1);
    expect(bad[0].code).toBe('5540-1S');
    expect(bad[0].doc).toBe('HC-PO-010087');
    expect(bad[0].why).toMatch(/scm\.mfg_products/);
  });

  test('a blank code is refused as its own reason, never as "not in the catalog"', () => {
    const bad = nonCatalogRefs([{ code: '  ' }, { code: null }], catalogPredicate(['8030-1S']));
    expect(bad.map((b) => b.why)).toEqual(['blank item_code', 'blank item_code']);
  });

  test('a missing predicate throws rather than passing everything', () => {
    // A guard whose predicate is undefined would call nothing and report clean —
    // the failure mode CLAUDE.md names: a verdict computed over nothing.
    expect(() => nonCatalogRefs([{ code: 'X' }], undefined)).toThrow(/predicate/);
  });

  test('the refusal names the row, the document and the file to fix', () => {
    const lines = formatNonCatalogRefusal(
      nonCatalogRefs([{ code: '5540-1S', doc: 'HC-PO-010087', acCode: 'HOK-5540 SOFA', sku: 'HOK-5540 SOFA' }],
        catalogPredicate(['8030-1S'])),
      { script: 'import-ac-outstanding-po.mjs' },
    ).join('\n');
    expect(lines).toMatch(/REFUSED/);
    expect(lines).toMatch(/5540-1S/);
    expect(lines).toMatch(/HC-PO-010087/);
    expect(lines).toMatch(/autocount-erp-mapping-1561\.csv/);
    expect(lines).toMatch(/import-ac-outstanding-po\.mjs/);
  });

  test('nothing to refuse produces no output at all', () => {
    expect(formatNonCatalogRefusal([], { script: 'x.mjs' })).toEqual([]);
  });
});

describe('aliasedCode — what an orphan should have been', () => {
  test('all four owner-confirmed pairs, bare model and compartment alike', () => {
    expect(aliasedCode('5530-1S', SOFA_MODEL_ALIAS)).toBe('9028-1S');
    expect(aliasedCode('5536-1S', SOFA_MODEL_ALIAS)).toBe('9058-1S');
    expect(aliasedCode('5537-1S', SOFA_MODEL_ALIAS)).toBe('8030-1S');
    expect(aliasedCode('5540-1S', SOFA_MODEL_ALIAS)).toBe('8030-1S');
    expect(aliasedCode('5540', SOFA_MODEL_ALIAS)).toBe('8030');
  });

  test('the split is on the FIRST hyphen, so a compartment suffix survives whole', () => {
    expect(aliasedCode('5540-1A(LHF)', SOFA_MODEL_ALIAS)).toBe('8030-1A(LHF)');
    expect(aliasedCode('5537-1S(R)-X', SOFA_MODEL_ALIAS)).toBe('8030-1S(R)-X');
  });

  test('a model the alias says nothing about resolves to null, never to itself', () => {
    // Refusing is the point: an orphan whose replacement would be a guess has
    // to stay visible. 5543 is a real model with no alias entry.
    expect(aliasedCode('5543-1S', SOFA_MODEL_ALIAS)).toBeNull();
    expect(aliasedCode('8030-1S', SOFA_MODEL_ALIAS)).toBeNull();
    expect(aliasedCode('', SOFA_MODEL_ALIAS)).toBeNull();
    expect(aliasedCode(null, SOFA_MODEL_ALIAS)).toBeNull();
    expect(aliasedCode('5540-1S', undefined)).toBeNull();
  });
});

describe('aliasFoldsForCatalog — the fold that belongs at READ time', () => {
  const catalog = catalogPredicate(['8030-1S', '9028-1S', '9058-1S', '5543-1S', 'DIVAN ONLY']);

  test('the four mapped codes fold onto the internal ones', () => {
    const moves = aliasFoldsForCatalog(['5530-1S', '5536-1S', '5537-1S', '5540-1S'], catalog, SOFA_MODEL_ALIAS);
    expect(Object.fromEntries(moves)).toEqual({
      '5530-1S': '9028-1S', '5536-1S': '9058-1S', '5537-1S': '8030-1S', '5540-1S': '8030-1S',
    });
  });

  test('a code the catalog already carries is never moved', () => {
    // The dangerous direction: a fold that fires on a working code would
    // silently repoint a line the ERP had right.
    expect(aliasFoldsForCatalog(['8030-1S', '5543-1S', 'DIVAN ONLY'], catalog, SOFA_MODEL_ALIAS).size).toBe(0);
  });

  test('a missing code the alias cannot resolve is left alone for the guard to refuse', () => {
    expect(aliasFoldsForCatalog(['5531-1S', 'NOT-A-CODE', ''], catalog, SOFA_MODEL_ALIAS).size).toBe(0);
  });

  test('a fold onto a code the catalog also lacks is not a fold', () => {
    expect(aliasFoldsForCatalog(['5540-1S'], catalogPredicate(['9028-1S']), SOFA_MODEL_ALIAS).size).toBe(0);
  });

  test('a missing predicate throws rather than folding nothing and reporting clean', () => {
    expect(() => aliasFoldsForCatalog(['5540-1S'], null, SOFA_MODEL_ALIAS)).toThrow(/predicate/);
  });
});

describe('every CSV item-code writer folds the alias, then refuses what is left', () => {
  for (const name of CSV_ITEM_CODE_WRITERS) {
    test(`${name} folds through SOFA_MODEL_ALIAS before it uses the mapped code`, () => {
      const src = read(name);
      expect(src).toMatch(/aliasFoldsForCatalog\s*\(/);
      // The fold has to happen where the mapping is READ, before the catalog
      // decides the line's group — that read is what sent an unknown code down
      // the non-sofa path with the decoder never consulted.
      const foldAt = src.indexOf('aliasFoldsForCatalog(');
      const useAt = src.search(/prodCat\.get|const grp = CATG/);
      expect(foldAt).toBeGreaterThan(-1);
      if (useAt > -1) expect(foldAt).toBeLessThan(useAt);
    });

    test(`${name} imports the guard and refuses on a finding`, () => {
      const src = read(name);
      expect(src).toMatch(/from ["']\.\/lib\/catalog-code-guard\.mjs["']/);
      expect(src).toMatch(/nonCatalogRefs\s*\(/);
      // The refusal has to STOP the run. A guard that only logs is the silent
      // fallback wearing a badge.
      expect(src).toMatch(/formatNonCatalogRefusal[\s\S]{0,600}?process\.exit\s*\(/);
    });
  }
});

describe('the repair leaves the row instead of exiting, and can never write an orphan', () => {
  for (const name of CSV_ITEM_CODE_REPAIRS) {
    test(`${name} folds the alias and imports the guard, like every other CSV item-code writer`, () => {
      const src = read(name);
      expect(src).toMatch(/aliasFoldsForCatalog\s*\(/);
      expect(src).toMatch(/from ["']\.\/lib\/catalog-code-guard\.mjs["']/);
      expect(src).toMatch(/nonCatalogRefs\s*\(/);
    });

    test(`${name} gates its write set on the catalogue predicate, and its UPDATE names only the two text columns`, () => {
      const src = read(name);
      // The refusal that matters here is the FILTER: a translated code the
      // catalogue lacks is pushed to a counted list, never onto `change`.
      expect(src).toMatch(/if\s*\(!inCatalog\(erp\)\)\s*\{\s*notInCatalog\.push/);
      const update = /UPDATE scm\.grn_items SET ([^`]*)/.exec(src);
      expect(update).toBeTruthy();
      // Quantity, price, dates and status must not appear in the write at all —
      // this is the claim the header makes about stock, expressed as a test.
      expect(update[1]).toMatch(/item_code\s*=/);
      expect(update[1]).toMatch(/material_name\s*=/);
      expect(update[1]).not.toMatch(/qty|price|discount|line_total|received_at|status|migrated_no_stock/);
    });

    test(`${name} only ever repairs a line with NO purchase-order link`, () => {
      // An attributed line's code was copied from a source that was already
      // translated. Re-deciding it here would be a second opinion about a value
      // that has an owner.
      const src = read(name);
      expect(src).toMatch(/purchase_order_item_id IS NULL/);
    });
  }

  /* The classifier itself, reproduced exactly, because the source tests prove
     the guard is present and not what it decides. */
  const classify = (cur, acToErp, exists, curName = null) => {
    const erp = acToErp.get(cur.trim().toUpperCase()) ?? null;
    if (!erp) return exists(cur) ? 'already-ok' : 'no-mapping';
    if (!exists(erp)) return 'not-in-catalogue';
    const name = NAMES[erp.toUpperCase()] ?? erp;
    if (cur.trim().toUpperCase() === erp.trim().toUpperCase() && curName === name) return 'already-ok';
    return erp;
  };
  const NAMES = { 'CODY 2.0 (F)-(SP)': 'Cody 2.0 single seat', 'REGAL (A)-(Q)': 'Regal queen', '8030-1S': 'Eight-thirty single' };
  const exists = catalogPredicate(['CODY 2.0 (F)-(SP)', 'REGAL (A)-(Q)', '8030-1S']);
  const acToErp = new Map([
    ['HOK-1007 (HF)(W) (SP)', 'CODY 2.0 (F)-(SP)'],
    ['HOK-2006(A) (Q)', 'REGAL (A)-(Q)'],
    ['HOK-5540 SOFA', '5540-1S'],
    ['CODY 2.0 (F)-(SP)', 'CODY 2.0 (F)-(SP)'],
  ]);

  test('the two codes the reconcile printed as identical strings resolve', () => {
    expect(classify('HOK-1007 (HF)(W) (SP)', acToErp, exists)).toBe('CODY 2.0 (F)-(SP)');
    expect(classify('HOK-2006(A) (Q)', acToErp, exists)).toBe('REGAL (A)-(Q)');
  });

  test('an unmapped code and a mapped-but-uncatalogued code are both LEFT, by different names', () => {
    expect(classify('NK-9999 (Q)', acToErp, exists)).toBe('no-mapping');
    // 5540-1S unfolded is exactly the orphan docs/bugs/0577 shipped.
    expect(classify('HOK-5540 SOFA', acToErp, exists)).toBe('not-in-catalogue');
  });

  test('the fold turns that same sofa row into a repair rather than a refusal', () => {
    const folded = new Map(acToErp);
    for (const [ac, erp] of folded) {
      const move = aliasFoldsForCatalog([erp], exists, SOFA_MODEL_ALIAS).get(erp);
      if (move) folded.set(ac, move);
    }
    expect(classify('HOK-5540 SOFA', folded, exists)).toBe('8030-1S');
  });

  test('convergent: a repaired row classifies as already-ok, not as a second rewrite', () => {
    // The row as this repair leaves it: the catalogue's code AND the
    // catalogue's name. Both have to be re-read for the second run to be a
    // no-op, which is why the script compares the name too.
    expect(classify('CODY 2.0 (F)-(SP)', acToErp, exists, 'Cody 2.0 single seat')).toBe('already-ok');
    expect(classify('REGAL (A)-(Q)', acToErp, exists, 'Regal queen')).toBe('already-ok');
    // A row whose code is right but whose name is still the book's code is NOT
    // done — that is the half-repaired shape, and it must still be picked up.
    expect(classify('CODY 2.0 (F)-(SP)', acToErp, exists, 'HOK-1007 (HF)(W) (SP)')).toBe('CODY 2.0 (F)-(SP)');
  });

  test('the live mapping file is idempotent on its own output — no code translates twice', () => {
    /* The repair writes the translated code back into the column it reads, so a
       chain (X -> Y -> Z) would flip those rows on every run. Measured here
       against the real file rather than asserted in a comment. */
    const csv = fs.readFileSync(path.join(SCRIPTS, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8')
      .replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    csv.shift();
    const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    const map = new Map();
    for (const line of csv) {
      const [ac, erp] = line.split(',');
      if (ac && erp && erp.trim()) map.set(norm(ac), norm(erp));
    }
    expect(map.size).toBeGreaterThan(1000);
    const chains = [...map].filter(([, erp]) => map.has(erp) && map.get(erp) !== erp);
    expect(chains).toEqual([]);
    // and the property is not vacuous: plenty of ERP codes ARE also book codes.
    expect([...map.values()].filter((e) => map.has(e)).length).toBeGreaterThan(100);
  });
});

describe('the mapping CSV is NOT where the fold goes', () => {
  /* Repointing the four rows there was tried and measured, and it moves the
     WRITE-BACK: src/services/autocount-item-map.ts is compiled from this same
     file and read in the other direction. Putting a HOK candidate on 9028-1S
     fires the owner's "prefer HOK" tie-break (autocount-item-code.ts rule 4) on
     codes rule 5 was written to own — 192 of the 697 corpus lines resolved to
     the wrong AutoCount item and the purchase side went 0 -> 18 refusals.

     So the rows STAY as the book spells them, and this test says so out loud:
     if somebody repoints them, autocount-item-code.test.ts goes red and this
     comment is what explains why. */
  test('the four HOK sofa rows still name the book model, and the alias covers them', () => {
    const csv = fs.readFileSync(path.join(SCRIPTS, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8')
      .replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    csv.shift();
    const rows = new Map();
    for (const line of csv) {
      const [acCode, erpCode] = line.split(',');
      if (/^HOK-55(30|36|37|40) SOFA$/.test(String(acCode ?? '').trim())) rows.set(acCode.trim(), String(erpCode ?? '').trim());
    }
    expect(Object.fromEntries(rows)).toEqual({
      'HOK-5530 SOFA': '5530-1S', 'HOK-5536 SOFA': '5536-1S',
      'HOK-5537 SOFA': '5537-1S', 'HOK-5540 SOFA': '5540-1S',
    });
    // and every one of them is a model the alias table can fold
    for (const erp of rows.values()) expect(SOFA_MODEL_ALIAS[erp.split('-')[0]]).toBeTruthy();
  });
});

describe('the withholding this fold undoes — the item_group verdict itself', () => {
  /* The source-level tests above prove the fold is CALLED. This one proves what
     calling it changes, because "aliasFoldsForCatalog appears in the file" would
     also be true of a fold applied after the catalogue had already been asked.

     The rule under test is topup-ac-po-lines.mjs's, reproduced exactly: the
     outstanding-PO importer classifies from the mapping CSV's category column,
     the SO-linked importer classifies from the catalogue, and a line whose two
     answers disagree ON THE SOFA AXIS is refused — that axis decides whether the
     build becomes one row per compartment or a single row, so it is two
     different repairs rather than two spellings of one label.

     The catalogue below is the shape production actually has: it carries the
     ALIASED sofa codes and has never carried the four book-spelled ones. */
  const CSV_GROUP = { MATTRESS: 'mattress', BEDFRAME: 'bedframe', ACC: 'accessory', ACCESSORY: 'accessory', BEDLINES: 'accessory', DIFFUSER: 'others', CARPET: 'others', DINING: 'others', OTHER: 'others', SERVICE: 'service', TRANS: 'service', SOFA: 'sofa' };
  const CATALOGUE_GROUP = { SOFA: 'sofa', BEDFRAME: 'bedframe', ACCESSORY: 'accessory', MATTRESS: 'mattress', SERVICE: 'service' };
  const catalogue = new Map([
    ['9028-1S', 'SOFA'], ['9058-1S', 'SOFA'], ['8030-1S', 'SOFA'], ['5535-1S', 'SOFA'],
    ['PILLOW-STD', 'ACCESSORY'],
  ]);
  const exists = catalogPredicate(catalogue.keys());

  /** Does the SOFA axis disagree? true = the family is WITHHELD. */
  const sofaSplit = (erp, csvCat) => {
    const fromCat = CATALOGUE_GROUP[catalogue.get(erp.toUpperCase()) ?? ''] ?? null;
    const fromCsv = CSV_GROUP[csvCat] ?? null;
    return ((fromCsv ?? 'others') === 'sofa') !== ((fromCat ?? 'others') === 'sofa');
  };
  const fold = (erp) => aliasFoldsForCatalog([erp], exists, SOFA_MODEL_ALIAS).get(erp) ?? erp;

  test('UNFOLDED, the catalogue answers "others" about a sofa and the family is withheld', () => {
    // Not because any row says `others` — because there is NO row, and the
    // `?? "others"` under the lookup reports that silence as a category.
    expect(catalogue.has('5536-1S')).toBe(false);
    expect(catalogue.has('5540-1S')).toBe(false);
    expect(sofaSplit('5536-1S', 'SOFA')).toBe(true);
    expect(sofaSplit('5540-1S', 'SOFA')).toBe(true);
  });

  test('FOLDED, both rules say sofa and nothing is withheld', () => {
    expect(fold('5536-1S')).toBe('9058-1S');
    expect(fold('5540-1S')).toBe('8030-1S');
    expect(sofaSplit(fold('5536-1S'), 'SOFA')).toBe(false);
    expect(sofaSplit(fold('5540-1S'), 'SOFA')).toBe(false);
  });

  test('all four alias pairs, and 5535 which is its OWN model and must never fold', () => {
    // Owner ruling: 5535 is not an alias of anything. It resolves on its own,
    // so the fold must leave it alone and it must not have been withheld.
    for (const erp of ['5530-1S', '5536-1S', '5537-1S', '5540-1S']) {
      expect(sofaSplit(erp, 'SOFA')).toBe(true);
      expect(sofaSplit(fold(erp), 'SOFA')).toBe(false);
    }
    expect(fold('5535-1S')).toBe('5535-1S');
    expect(sofaSplit('5535-1S', 'SOFA')).toBe(false);
  });

  test('the fold cannot manufacture agreement for a non-sofa, or hide a real disagreement', () => {
    // An accessory the catalogue knows: both rules say accessory, no split, and
    // the fold is a no-op. The dangerous direction is a fold that quiets a
    // genuine mismatch, so a code the alias cannot resolve must still split.
    expect(sofaSplit('PILLOW-STD', 'ACC')).toBe(false);
    expect(fold('PILLOW-STD')).toBe('PILLOW-STD');
    expect(fold('5543-1S')).toBe('5543-1S');
    expect(sofaSplit('5543-1S', 'SOFA')).toBe(true);
  });
});

describe('SOFA_MODEL_ALIAS has exactly one home', () => {
  /* The alias is the ERP's statement of sofa identity and it decides document
     SHAPE, so a second copy is not redundancy — it is a second answer waiting to
     drift from the first. Two copies were found on 2026-09-08 in the two photo
     importers, byte-identical to the real one and therefore invisible; they were
     replaced with an import. This test is what stops the third.

     It looks for a DEFINITION, not a mention: a usage, a doc comment or a
     workflow header quoting the table is fine and is how the rule gets
     explained. */
  const ROOTS = [path.join(here, '..', 'scripts'), path.join(here, '..', 'src')];
  const DEFINITION = /(?:export\s+)?const\s+SOFA_MODEL_ALIAS\s*=/;

  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(mjs|js|ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  test('exactly one file DEFINES it, and it is lib/parse-sofa.mjs', () => {
    const files = ROOTS.flatMap((r) => walk(r));
    // A verdict computed over nothing must never read as a pass (CLAUDE.md).
    expect(files.length).toBeGreaterThan(100);
    const definers = files
      .filter((f) => DEFINITION.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(here, '..'), f).split(path.sep).join('/'));
    expect(definers).toEqual(['scripts/lib/parse-sofa.mjs']);
  });

  test('the one definition is the owner-confirmed table, unchanged', () => {
    // 5535 is deliberately absent: the owner ruled it is its OWN model and must
    // never be aliased. 5537 -> 8030 is his ruling too (保留).
    expect(SOFA_MODEL_ALIAS).toEqual({ 5530: '9028', 5536: '9058', 5537: '8030', 5540: '8030' });
    expect(SOFA_MODEL_ALIAS['5535']).toBeUndefined();
  });
});
