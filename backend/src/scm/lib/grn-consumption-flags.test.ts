
import { describe, it, expect } from 'vitest';
import { computeGrnFlags } from './grn-consumption-flags';

const line = (qty_accepted: number, invoiced_qty = 0, returned_qty = 0) =>
  ({ qty_accepted, invoiced_qty, returned_qty });

describe('computeGrnFlags', () => {
  it('reports no children on an untouched receipt', () => {
    expect(computeGrnFlags([line(10), line(4)])).toEqual({
      has_children: false, fully_invoiced: false, fully_returned: false,
    });
  });

  it('reports children as soon as ONE line has been invoiced or returned', () => {
    expect(computeGrnFlags([line(10, 1), line(4)]).has_children).toBe(true);
    expect(computeGrnFlags([line(10), line(4, 0, 1)]).has_children).toBe(true);
  });

  it('is fully invoiced only when EVERY accepted line is', () => {
    expect(computeGrnFlags([line(10, 10), line(4, 4)]).fully_invoiced).toBe(true);
    expect(computeGrnFlags([line(10, 10), line(4, 3)]).fully_invoiced).toBe(false);
  });

  it('counts an OVER-invoiced line as satisfied, not as short', () => {
    expect(computeGrnFlags([line(10, 12)]).fully_invoiced).toBe(true);
  });

  it('treats a qty_accepted = 0 line as already satisfied', () => {
    expect(computeGrnFlags([line(10, 10), line(0)]).fully_invoiced).toBe(true);
  });

  it('is NOT fully consumed when there is no accepted line at all', () => {
    expect(computeGrnFlags([line(0), line(0)])).toEqual({
      has_children: false, fully_invoiced: false, fully_returned: false,
    });
    expect(computeGrnFlags([])).toEqual({
      has_children: false, fully_invoiced: false, fully_returned: false,
    });
  });

  it('tolerates null / missing counters', () => {
    expect(computeGrnFlags([{ qty_accepted: 5, invoiced_qty: null, returned_qty: null }])).toEqual({
      has_children: false, fully_invoiced: false, fully_returned: false,
    });
    expect(computeGrnFlags([{ qty_accepted: null }]).fully_invoiced).toBe(false);
  });

  it('tracks returns independently of invoicing', () => {
    expect(computeGrnFlags([line(6, 0, 6)])).toEqual({
      has_children: true, fully_invoiced: false, fully_returned: true,
    });
  });
});
