// HC-0137: a delivery order split across warehouses names every draft on the
// scan card, which links only the first.
import { describe, expect, test } from 'vitest';
import { splitNote } from './grn-scan-draft';

describe('splitNote', () => {
  test('names every draft when the scan made more than one', () => {
    expect(splitNote(['HC-GRN-2610-169', 'HC-GRN-2610-170'])).toBe(
      'This delivery order made 2 draft goods receipts, one per warehouse: HC-GRN-2610-169, HC-GRN-2610-170.',
    );
  });
  test('says nothing for a single draft', () => {
    expect(splitNote(['HC-GRN-2610-169'])).toBeNull();
  });
});
