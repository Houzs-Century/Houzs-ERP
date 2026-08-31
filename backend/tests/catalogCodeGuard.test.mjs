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

/** Every importer that resolves a book ItemCode through the mapping CSV and
 *  then writes an item_code. Both fell back silently; both must now refuse. */
const IMPORTERS = ['import-ac-outstanding-po.mjs', 'import-ac-so-linked-pos.mjs'];

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

describe('the importers fold the alias, then refuse what is left', () => {
  for (const name of IMPORTERS) {
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
