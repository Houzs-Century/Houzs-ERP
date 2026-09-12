import { describe, it, expect } from 'vitest';
import {
  longestCommonPrefix,
  rollUpToSets,
  companyCodesPresent,
  type PoOutstandingLineRow,
} from './po-outstanding-rollup';

const line = (o: Partial<PoOutstandingLineRow>): PoOutstandingLineRow => ({
  company_id: 1,
  company_code: 'HOUZS',
  po_number: 'HC-PO-010150',
  creditor_code: '400-A004',
  creditor_name: 'ARMANI SOFA SDN. BHD.',
  item_group: 'sofa',
  item_code: '',
  item_desc2: '',
  remaining_qty: 1,
  ...o,
});

describe('longestCommonPrefix', () => {
  it('reduces sofa component codes to the set base, trimmed of separators', () => {
    expect(longestCommonPrefix(['9058-1A(LHF)', '9058-1NA', '9058-L(RHF)'])).toBe('9058');
  });
  it('returns the code itself for a single code', () => {
    expect(longestCommonPrefix(['AERO-MP (K)'])).toBe('AERO-MP (K)');
  });
  it('is empty for an empty list or no shared prefix', () => {
    expect(longestCommonPrefix([])).toBe('');
    expect(longestCommonPrefix(['ABC', 'XYZ'])).toBe('');
  });
});

describe('rollUpToSets', () => {
  it('folds sofa components that share PO + item_desc2 into one set row', () => {
    const cfg = '1EFL+1NA+C+1EFR (32in)/Col:HR805-90';
    const rows = [
      line({ item_code: '9058-1A(LHF)', item_desc2: cfg, remaining_qty: 1 }),
      line({ item_code: '9058-1NA', item_desc2: cfg, remaining_qty: 1 }),
      line({ item_code: '9058-L(RHF)', item_desc2: cfg, remaining_qty: 1 }),
    ];
    const sets = rollUpToSets(rows);
    expect(sets).toHaveLength(1);
    expect(sets[0].set_code).toBe('9058');
    expect(sets[0].component_count).toBe(3);
    expect(sets[0].remaining_qty).toBe(3);
    expect(sets[0].component_codes).toBe('9058-1A(LHF), 9058-1NA, 9058-L(RHF)');
  });

  it('does NOT merge same-code lines that carry different item_desc2 (e.g. pillows of different colour)', () => {
    const rows = [
      line({ item_code: 'SQUARE PILLOW', item_desc2: 'colour : B0315-9' }),
      line({ item_code: 'SQUARE PILLOW', item_desc2: 'colour : B0315-7' }),
      line({ item_code: 'SQUARE PILLOW', item_desc2: 'colour : B0315-8' }),
    ];
    expect(rollUpToSets(rows)).toHaveLength(3);
  });

  it('keeps blank-desc2 lines separate by item_code (never over-merges specless accessories)', () => {
    const rows = [
      line({ item_code: 'AERO-MP (K)', item_desc2: '', item_group: 'accessory', remaining_qty: 70 }),
      line({ item_code: 'AERO-MP (Q)', item_desc2: '', item_group: 'accessory', remaining_qty: 50 }),
    ];
    const sets = rollUpToSets(rows);
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.remaining_qty)).toEqual([70, 50]);
  });

  it('does not merge identical lines across different POs', () => {
    const cfg = 'same config';
    const rows = [
      line({ po_number: 'HC-PO-1', item_code: '9058-1NA', item_desc2: cfg }),
      line({ po_number: 'HC-PO-2', item_code: '9058-1NA', item_desc2: cfg }),
    ];
    expect(rollUpToSets(rows)).toHaveLength(2);
  });
});

describe('companyCodesPresent', () => {
  it('returns distinct company codes in first-seen order, ignoring blanks', () => {
    const rows = [
      line({ company_code: 'HOUZS' }),
      line({ company_code: '2990' }),
      line({ company_code: 'HOUZS' }),
      line({ company_code: '' }),
    ];
    expect(companyCodesPresent(rows)).toEqual(['HOUZS', '2990']);
  });
});
