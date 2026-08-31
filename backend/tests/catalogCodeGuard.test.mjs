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
import { aliasedCode, catalogPredicate, nonCatalogRefs, formatNonCatalogRefusal } from '../scripts/lib/catalog-code-guard.mjs';
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

describe('the importers consult the guard', () => {
  for (const name of IMPORTERS) {
    test(`${name} imports it and refuses on a finding`, () => {
      const src = read(name);
      expect(src).toMatch(/from ["']\.\/lib\/catalog-code-guard\.mjs["']/);
      expect(src).toMatch(/nonCatalogRefs\s*\(/);
      // The refusal has to STOP the run. A guard that only logs is the silent
      // fallback wearing a badge.
      expect(src).toMatch(/formatNonCatalogRefusal[\s\S]{0,600}?process\.exit\s*\(/);
    });
  }
});

describe('the mapping CSV', () => {
  /* The four rows this PR repointed. The alias is the ERP's own statement that
     these four book models ARE the aliased model (owner 2026-08-31: 对相同的),
     so a mapping row that still names the alias KEY is pointing at a code the
     alias itself says is not the internal one. */
  test('no row maps a book code onto an aliased sofa model rather than its alias', () => {
    const csv = fs.readFileSync(path.join(SCRIPTS, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8')
      .replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    csv.shift();
    const offenders = [];
    for (const line of csv) {
      const [acCode, erpCode] = line.split(',');
      const base = String(erpCode ?? '').trim().split('-')[0].trim();
      if (SOFA_MODEL_ALIAS[base]) offenders.push(`${acCode} -> ${erpCode} (alias says ${SOFA_MODEL_ALIAS[base]})`);
    }
    expect(offenders).toEqual([]);
  });
});
