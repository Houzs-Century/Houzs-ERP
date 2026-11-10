/* Sister review G3: a goods receipt may only tick off PO lines from its own
   supplier. The manual create, the add-line and the header supplier change
   compared the PO's status, hold and company but never its supplier. */
import { describe, it, expect } from 'vitest';
import grnsSource from '../src/scm/routes/grns.ts?raw';
import { stripComments } from '../scripts/lib/classify-tests.mjs';
import { assertPoLinesFromSupplier } from '../src/scm/lib/grn-po-supplier';

type Row = { id: string; company_id: number; po: { po_number: string; supplier_id: string } };

function fakeSb(rows: Row[], fail = false) {
  return {
    from: (table: string) => {
      expect(table).toBe('purchase_order_items');
      const filters: Array<(r: Row) => boolean> = [];
      const q = {
        select: () => q,
        in: (col: string, vals: string[]) => { filters.push((r) => vals.includes((r as unknown as Record<string, string>)[col]!)); return q; },
        eq: (col: string, val: unknown) => { filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val); return q; },
        then: (f: (v: unknown) => unknown) => Promise.resolve(
          fail ? { data: null, error: { message: 'boom' } } : { data: rows.filter((r) => filters.every((p) => p(r))), error: null },
        ).then(f),
      };
      return q;
    },
  };
}
const ctx = { get: (k: string) => (k === 'companyId' ? 1 : k === 'allowedCompanyIds' ? [1] : undefined) } as never;

const rows: Row[] = [
  { id: 'poi-a', company_id: 1, po: { po_number: 'PO-A', supplier_id: 'sup-a' } },
  { id: 'poi-b', company_id: 1, po: { po_number: 'PO-B', supplier_id: 'sup-b' } },
];

describe('assertPoLinesFromSupplier', () => {
  it('passes when every PO line is on the receipt supplier\'s PO', async () => {
    expect(await assertPoLinesFromSupplier(fakeSb(rows), ctx, ['poi-a'], 'sup-a')).toEqual({ ok: true });
  });

  it('refuses a line from another supplier\'s PO and names it', async () => {
    const r = await assertPoLinesFromSupplier(fakeSb(rows), ctx, ['poi-a', 'poi-b'], 'sup-a');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'po_supplier_mismatch', poItemId: 'poi-b', poNumber: 'PO-B' });
  });

  it('refuses a line it cannot read back rather than passing it', async () => {
    const r = await assertPoLinesFromSupplier(fakeSb(rows), ctx, ['poi-missing'], 'sup-a');
    expect(r.ok).toBe(false);
  });

  it('a failed read is 503, not a pass', async () => {
    const r = await assertPoLinesFromSupplier(fakeSb(rows, true), ctx, ['poi-a'], 'sup-a');
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it('no linked lines is nothing to check', async () => {
    expect(await assertPoLinesFromSupplier(fakeSb(rows), ctx, [null, undefined], 'sup-a')).toEqual({ ok: true });
  });
});

describe('grns.ts applies the supplier rule at every manual bind point', () => {
  const code = stripComments(grnsSource);
  const handler = (start: string) => {
    const i = code.indexOf(start);
    expect(i).toBeGreaterThan(-1);
    const next = code.indexOf('\ngrns.', i + start.length);
    return code.slice(i, next === -1 ? undefined : next);
  };

  it.each([
    ["POST / (manual create)", "grns.post('/', async (c) => {"],
    ["POST /:id/items (add-line)", "grns.post('/:id/items', async (c) => {"],
    ["PATCH /:id (header supplier change)", "grns.patch('/:id', async (c) => {"],
  ])('%s calls assertPoLinesFromSupplier', (_label, start) => {
    expect(handler(start)).toMatch(/assertPoLinesFromSupplier\(/);
  });
});
