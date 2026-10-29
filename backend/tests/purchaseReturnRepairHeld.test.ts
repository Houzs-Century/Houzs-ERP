/* HC-0139: a live REPAIR return holds its units. returned_qty leaves them out
 * (so a repair does not re-open the PO), but the return caps must still count
 * them, or the same unit is returned twice and stock goes negative. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repairHeldQty } from '../src/scm/routes/purchase-returns';
import { capVerdict } from '../src/scm/lib/qty-cap';

const fakeSb = (lines: unknown[], prs: unknown[]) => ({
  from: (t: string) => ({
    select: () => ({ in: async () => ({ data: t === 'purchase_return_items' ? lines : prs, error: null }) }),
  }),
});

describe('repairHeldQty', () => {
  const lines = [
    { id: 'l1', grn_item_id: 'g1', qty_returned: 1, purchase_return_id: 'A' },
    { id: 'l2', grn_item_id: 'g1', qty_returned: 2, purchase_return_id: 'B' },
    { id: 'l3', grn_item_id: 'g1', qty_returned: 4, purchase_return_id: 'C' },
    { id: 'l4', grn_item_id: 'g1', qty_returned: 8, purchase_return_id: 'D' },
  ];
  const prs = [
    { id: 'A', status: 'POSTED', kind: 'REPAIR' },
    { id: 'B', status: 'DRAFT', kind: 'REPAIR' },
    { id: 'C', status: 'CANCELLED', kind: 'REPAIR' },
    { id: 'D', status: 'POSTED', kind: 'CREDIT' },
  ];

  it('counts live REPAIR lines only (not cancelled, not CREDIT)', async () => {
    const m = await repairHeldQty(fakeSb(lines, prs), ['g1'], null);
    expect(m?.get('g1')).toBe(3);
  });

  it('leaves out the line being edited', async () => {
    const m = await repairHeldQty(fakeSb(lines, prs), ['g1'], 'l1');
    expect(m?.get('g1')).toBe(2);
  });

  it('returns null when a read fails', async () => {
    const bad = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'x' } }) }) }) };
    expect(await repairHeldQty(bad, ['g1'], null)).toBeNull();
  });

  it('GRN qty 1 -> REPAIR A held -> second return of 1 is refused', () => {
    expect(capVerdict({ requested: 1, cap: 1, drawn: 0 + 1 })).toMatchObject({ error: 'qty_exceeds_remaining', remaining: 0 });
  });
});

describe('every return cap subtracts the held repair units', () => {
  const BE = readFileSync(resolve(__dirname, '../src/scm/routes/purchase-returns.ts'), 'utf8');
  it('wires repairHeldQty into create, both copy paths, add-line and edit-line', () => {
    expect(BE.match(/await repairHeldQty\(/g)?.length).toBe(5);
  });
});
