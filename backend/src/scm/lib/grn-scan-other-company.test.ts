import { describe, expect, test, vi } from 'vitest';

vi.mock('../../services/aiUsage', () => ({ recordAi: vi.fn() }));
import { otherCompanyNote } from './grn-scan-draft';

const companies = [{ id: 1, code: 'HOUZS', name: 'Houzs Century' }, { id: 2, code: '2990', name: "2990's Home" }];

describe('otherCompanyNote', () => {
  test('a 2990 PO scanned under Houzs says so and where to go', () => {
    const note = otherCompanyNote(['2990-PO-2609-046'], 1, companies);
    expect(note).toContain("2990's Home");
    expect(note).toContain('Houzs Century');
  });
  test('a Houzs PO printed on a row, scanned under 2990', () => {
    expect(otherCompanyNote([null, 'HC-PO-2610-108'], 2, companies)).toContain('Houzs Century');
  });
  test('our own company, or a supplier reference, says nothing', () => {
    expect(otherCompanyNote(['HC-PO-2610-108'], 1, companies)).toBeNull();
    expect(otherCompanyNote(['S/O 1878', null], 1, companies)).toBeNull();
  });
});
