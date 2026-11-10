// Owner rule 2026-11-10: the printed DO's Source PO / Rack cells read the PO and
// rack locked at the first ship; an older, unstamped DO prints the worked-out
// value with a trailing " *" and a note under the table says what it means.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));

import { pickingCell, WORKED_OUT_NOTE } from './delivery-order-pdf';

describe('pickingCell', () => {
  it('prints a locked value as is, one per line', () => {
    expect(pickingCell(['2990-PO-2610-050', '2990-PO-2610-061'], 'locked')).toBe('2990-PO-2610-050\n2990-PO-2610-061');
  });
  it('marks a worked-out value', () => {
    expect(pickingCell(['Rack L8.2'], 'worked_out')).toBe('Rack L8.2 *');
    expect(WORKED_OUT_NOTE.startsWith('* ')).toBe(true);
  });
  it('an empty cell is a dash, never a lone star', () => {
    expect(pickingCell([], 'worked_out')).toBe('—');
    expect(pickingCell(null, null)).toBe('—');
  });
});
