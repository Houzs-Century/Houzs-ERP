// HC-0134: the PO cost path read the master maintenance config of ANY company, so
// a Houzs PO line got 2990's divan/leg surcharges. The read is now company-scoped.
import { describe, it, expect } from 'vitest';
import { resolveMaintenanceConfigForSupplier } from './po-pricing';

type Row = Record<string, any>;
const rows: Row[] = [
  { scope: 'master', company_id: 2, effective_from: '2026-01-01', created_at: '2026-10-01', config: { who: '2990' } },
  { scope: 'master', company_id: 1, effective_from: '2025-01-01', created_at: '2025-01-01', config: { who: 'houzs' } },
  { scope: 'supplier:S9', company_id: 2, effective_from: '2026-01-01', created_at: '2026-01-01', config: { who: '2990-supplier' } },
];

function fakeSb(data: Row[]) {
  return {
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), q),
        lte: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({
          data: data
            .filter((r) => eqs.every(([c, v]) => r[c] === v))
            .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null,
        }),
      };
      return q;
    },
  };
}

describe('resolveMaintenanceConfigForSupplier is company-scoped (HC-0134)', () => {
  it('a Houzs PO gets Houzs master even though 2990 saved a newer one', async () => {
    const r = await resolveMaintenanceConfigForSupplier(fakeSb(rows), 'S1', 1);
    expect(r).toEqual({ config: { who: 'houzs' }, scope: 'master' });
  });
  it('a company with no master gets null, not another company master', async () => {
    const r = await resolveMaintenanceConfigForSupplier(fakeSb(rows), 'S1', 3);
    expect(r).toEqual({ config: null, scope: null });
  });
  it("another company's supplier-scope row is not read", async () => {
    const r = await resolveMaintenanceConfigForSupplier(fakeSb(rows), 'S9', 1);
    expect(r.config).toEqual({ who: 'houzs' });
  });
});
