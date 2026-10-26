// The PO cell of a stock-take line (Sim 2026-10-26): one wording for the
// screen, the PDF and the Excel, and a model header that sums its lines.
import { describe, expect, it } from 'vitest';
import { fmtStockSources, mergeStockSources } from './stock-take-sources';

describe('stock take PO sources', () => {
  it('prints each source with its qty, in the order the server sent', () => {
    expect(fmtStockSources([
      { label: 'AC opening', po: false, qty: 2 },
      { label: 'HC-PO-010089', po: true, qty: 1 },
    ])).toBe('AC opening (2), HC-PO-010089 (1)');
    expect(fmtStockSources([])).toBe('');
    expect(fmtStockSources(null)).toBe('');
  });

  it('a model header sums the same PO across its variant lines', () => {
    expect(mergeStockSources([
      [{ label: 'HC-PO-010089', po: true, qty: 1 }],
      null,
      [{ label: 'AC opening', po: false, qty: 2 }, { label: 'HC-PO-010089', po: true, qty: 3 }],
    ])).toEqual([
      { label: 'HC-PO-010089', po: true, qty: 4 },
      { label: 'AC opening', po: false, qty: 2 },
    ]);
  });
});
