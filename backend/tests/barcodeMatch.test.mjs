// The rules import-product-barcodes.mjs applies before it writes a barcode.
import { describe, expect, test } from 'vitest';
import { ean13Valid, normCode, stripAk } from '../scripts/lib/barcode-match.mjs';

describe('barcode-match', () => {
  test('an EAN-13 with a wrong check digit is refused', () => {
    expect(ean13Valid('9557108620766')).toBe(true);
    expect(ean13Valid('9557108423367')).toBe(true);
    expect(ean13Valid('9557108620767')).toBe(false);
    expect(ean13Valid('955710862076')).toBe(false);
  });
  test('a code matches with spaces collapsed and case ignored', () => {
    expect(normCode('  AK-RD DIF EV lll LIN 24 ')).toBe('AK-RD DIF EV LLL LIN 24');
    expect(normCode('AK  ARO - BE HP')).toBe('AK ARO - BE HP');
  });
  test('the supplier AK prefix is dropped for the second try only', () => {
    expect(stripAk('AK-AF AM CL GRY 4KFIT')).toBe('AF AM CL GRY 4KFIT');
    expect(stripAk('AK  ARO - BE HP CDL MD LIFT')).toBe('ARO - BE HP CDL MD LIFT');
    expect(stripAk('AERO-MP (K)')).toBe('AERO-MP (K)');
  });
});
