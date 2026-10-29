/* HC-0139: a live REPAIR return holds its units. returned_qty leaves them out
 * (so a repair does not re-open the PO), but the return caps must still count
 * them, or the same unit is returned twice and stock goes negative. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repairHeldQty, editLineCapRefusal } from '../src/scm/routes/purchase-returns';
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

/* Table-routing stand-in: grns line row, PR header, PR lines, PR headers. */
function editSb(o: { kind: string | null; headErr?: boolean; accepted: number; lines: unknown[]; prs: unknown[] }) {
  return {
    from: (t: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: async () => ({ data: t === 'purchase_return_items' ? o.lines : o.prs, error: null }),
        maybeSingle: async () => t === 'purchase_returns'
          ? (o.headErr ? { data: null, error: { message: 'blip' } } : { data: { kind: o.kind }, error: null })
          : { data: { qty_accepted: o.accepted, returned_qty: 0 }, error: null },
      };
      return b;
    },
  };
}

describe('editLineCapRefusal', () => {
  const own = [{ id: 'L', grn_item_id: 'g', qty_returned: 2, purchase_return_id: 'P' }];
  const repairP = [{ id: 'P', status: 'POSTED', kind: 'REPAIR' }];
  const base = { prId: 'P', itemId: 'L', grnItemId: 'g', prevQty: 2 };

  it('REPAIR line GRN qty 2 -> edit to 4 is refused (own qty not given back)', async () => {
    const r = await editLineCapRefusal(editSb({ kind: 'REPAIR', accepted: 2, lines: own, prs: repairP }), { ...base, qtyReturned: 4 });
    expect(r).toMatchObject({ error: 'qty_exceeds_remaining', remaining: 2 });
  });

  it('REPAIR line edited down/within the GRN qty passes', async () => {
    const r = await editLineCapRefusal(editSb({ kind: 'REPAIR', accepted: 2, lines: own, prs: repairP }), { ...base, qtyReturned: 1 });
    expect(r).toBeNull();
  });

  it('another live REPAIR line on the same GRN line is held', async () => {
    const lines = [...own, { id: 'M', grn_item_id: 'g', qty_returned: 1, purchase_return_id: 'Q' }];
    const prs = [...repairP, { id: 'Q', status: 'POSTED', kind: 'REPAIR' }];
    const r = await editLineCapRefusal(editSb({ kind: 'REPAIR', accepted: 3, lines, prs }), { ...base, qtyReturned: 3 });
    expect(r).toMatchObject({ error: 'qty_exceeds_remaining', remaining: 2 });
  });

  it('a failed header read refuses instead of treating the line as CREDIT', async () => {
    const r = await editLineCapRefusal(editSb({ kind: 'REPAIR', headErr: true, accepted: 2, lines: own, prs: repairP }), { ...base, qtyReturned: 4 });
    expect(r).toMatchObject({ error: 'cap_check_failed' });
  });
});

describe('route wiring', () => {
  const BE = readFileSync(resolve(__dirname, '../src/scm/routes/purchase-returns.ts'), 'utf8');
  it('edit-line uses editLineCapRefusal and answers cap_check_failed with 500', () => {
    expect(BE).toContain("const capLock = await editLineCapRefusal(sb, { prId, itemId, grnItemId, qtyReturned, prevQty });");
    expect(BE).toContain("c.json(capLock, capLock.error === 'cap_check_failed' ? 500 : 409)");
  });
  it('every other cap binds the held map and refuses when it is null', () => {
    for (const v of ['repairHeld', 'heldA', 'heldB', 'heldAdd']) {
      expect(BE).toMatch(new RegExp(String.raw`const ${v} = await repairHeldQty\([^\n]*\);\s*\n?\s*if \(!${v}\) `));
      expect(BE).toContain(`${v}.get(`);
    }
  });
});
