/* The item-code mapping sheet is RFC4180, and the reconcile checker read it
 * with `line.split(",")`.
 *
 * Three rows of data/autocount-erp-mapping-1561.csv quote their ERP code because
 * it contains the inch mark:
 *
 *   DL-GENERASI (S),"DUNLOPILLO GENERASI 5"" MATT (S)",NEW,MATTRESS,400-D001
 *
 * A naive split cuts that into a fragment that can never equal what the ERP
 * stores, so every sales-order line carrying one of those three codes was
 * reported as an item-code DEFECT - 40 of the 101 in front of the owner on
 * 2026-09-08 (docs/bugs/0689). These tests pin the parser AND the three
 * populations the 101 turned out to be, because "derived, so it measures our
 * translation" was an assumption nobody had measured.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvLine, readMappingCsv, normCode } from '../scripts/lib/ac-mapping-csv.mjs';
import { classifyItemCode, modelOf, isCompartmentCode } from '../scripts/lib/item-code-class.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(HERE, '..', 'scripts', 'data', 'autocount-erp-mapping-1561.csv');

describe('parseCsvLine - RFC4180, not split(",")', () => {
  it('keeps a quoted field whole and un-doubles the embedded quote', () => {
    expect(parseCsvLine('DL-GENERASI (S),"DUNLOPILLO GENERASI 5"" MATT (S)",NEW,MATTRESS,400-D001'))
      .toEqual(['DL-GENERASI (S)', 'DUNLOPILLO GENERASI 5" MATT (S)', 'NEW', 'MATTRESS', '400-D001']);
  });
  it('is unchanged on an unquoted row', () => {
    expect(parseCsvLine('HOK-1013 (Q),JAGER-(Q),EXISTS,BEDFRAME,400-O002'))
      .toEqual(['HOK-1013 (Q)', 'JAGER-(Q)', 'EXISTS', 'BEDFRAME', '400-O002']);
  });
  it('what split(",") would have produced is NOT what the ERP stores', () => {
    const naive = 'DL-GENERASI (S),"DUNLOPILLO GENERASI 5"" MATT (S)",NEW,MATTRESS,400-D001'.split(',')[1];
    expect(naive).not.toBe('DUNLOPILLO GENERASI 5" MATT (S)');
  });
});

describe('the real sheet', () => {
  const map = readMappingCsv(fs.readFileSync(CSV, 'utf8'));
  it('resolves the three quoted rows to what production actually stores', () => {
    expect(map.get(normCode('DL-GENERASI (S)')).erp).toBe('DUNLOPILLO GENERASI 5" MATT (S)');
    expect(map.get(normCode('DL-GENERASI (SS)')).erp).toBe('DUNLOPILLO GENERASI 5" MATT (SS)');
    expect(map.get(normCode('DL-GENERASI (K)')).erp).toBe('DUNLOPILLO GENERASI 5" MATT (K)');
  });
  it('carries the category, which is where item_group comes from', () => {
    expect(map.get(normCode('HOK-2008(A) (K)')).cat).toBe('BEDFRAME');
  });
});

describe('modelOf - the sofa alias, folded the way the floor writes it', () => {
  it('folds the four pairs the owner confirmed', () => {
    expect(modelOf('HOK-5536 SOFA')).toBe('9058');
    expect(modelOf('HOK-5540 SOFA')).toBe('8030');
    expect(modelOf('HOK-5530 SOFA')).toBe('9028');
    expect(modelOf('HOK-5537 SOFA')).toBe('8030');
  });
  it('leaves 5535 alone - it is its own model, and folding it would hide a finding', () => {
    expect(modelOf('HOK-5535 SOFA')).toBe('5535');
    expect(modelOf('HOK-5535 SOFA')).not.toBe(modelOf('8030-CNR'));
  });
  it('yields no model for an accessory whose NAME contains the word sofa', () => {
    expect(modelOf('AMN-SOFA PILLOW')).toBe(null);
  });
});

describe('isCompartmentCode', () => {
  it('recognises a compartment even when AutoCount never wrote the word SOFA', () => {
    expect(isCompartmentCode('7179-L(LHF)')).toBe(true);
    expect(isCompartmentCode('2379-2S')).toBe(true);
  });
  it('does not claim an ordinary hyphenated code', () => {
    expect(isCompartmentCode('JAGER-(Q)')).toBe(false);
    expect(isCompartmentCode('BEDFRAME KIV')).toBe(false);
  });
});

describe('classifyItemCode - the three populations inside one number', () => {
  const map = readMappingCsv(fs.readFileSync(CSV, 'utf8'));
  const cls = (acCode, erpCode, groupSize) => classifyItemCode({ acCode, erpCode, mapping: map, groupSize });

  it('TRANSLATION when the sheet resolves - the 40 the naive parser invented', () => {
    const r = cls('DL-GENERASI (S)', 'DUNLOPILLO GENERASI 5" MATT (S)');
    expect(r.cls).toBe('translation');
  });
  it('TRANSLATION when our code IS the book code, whatever longer name the sheet prefers', () => {
    const r = cls('DL-CS2 NN-WINTER SLEEP MATT (K', 'DL-CS2 NN-WINTER SLEEP MATT (K');
    expect(r.cls).toBe('translation');
  });
  it('DECOMPOSITION for a compartment whose AutoCount code never says SOFA', () => {
    expect(cls('THL-7179', '7179-L(LHF)').cls).toBe('decomposition');
    expect(cls('THL-2379', '2379-2S').cls).toBe('decomposition');
  });
  it('DIFFERENT when the models disagree after the alias fold', () => {
    const r = cls('HOK-5535 SOFA', '8030-CNR', 3);
    expect(r.cls).toBe('different');
    expect(r.wanted).toBe('5535-1S');
  });
  it('DIFFERENT for a bedframe naming another bed - the shape that put a REGAL in front of a TRION', () => {
    const r = cls('HOK-2008(A) (K)', 'REGAL (A)-(K)');
    expect(r.cls).toBe('different');
    expect(r.wanted).toBe('TRION (A) (HB STR)-(K)');
  });
  it('DIFFERENT for a placeholder', () => {
    expect(cls('HOK-1013 (K)', 'BEDFRAME KIV').cls).toBe('different');
  });
  it('DIFFERENT when only one side carries a model - never excused as a sofa', () => {
    const r = cls('HOK-SQUARE PILLOW', '9028-1A(RHF)');
    expect(r.cls).toBe('different');
  });
  it('DIFFERENT when the size differs, even inside the same family', () => {
    expect(cls('HOK-1013 (SS)', 'JAGER-(Q)').cls).toBe('different');
    expect(cls('AK-ULTIMATE MATT (K)', 'AKEMI ULTIMATE MATT (Q)').cls).toBe('different');
  });
  it('never invents a wanted code when the sheet is silent', () => {
    const r = cls('NOT-IN-THE-SHEET (K)', 'ANYTHING');
    expect(r.cls).toBe('different');
    expect(r.wanted).toBe(null);
  });
});
