// planningPoNosByDoc — pins the one rule this adapter owns: the shared
// cross-company board is walked ONCE PER COMPANY, each walk scoped to its own
// company_id, and rows without a company are never walked unscoped.
import { describe, expect, test, vi } from 'vitest';

const walk = vi.fn();
vi.mock('./so-converted-po', () => ({
  soConvertedPoNumbers: (...args: unknown[]) => walk(...args),
}));

import { planningPoNosByDoc } from './planning-po-nos';

describe('planningPoNosByDoc', () => {
  test('groups doc_nos by company and scopes each walk to that company', async () => {
    walk.mockImplementation(async (_sb: unknown, docs: string[], companyId: number) =>
      new Map(docs.map((d) => [d, [`PO-${companyId}-${d}`]])),
    );
    const out = await planningPoNosByDoc({}, [
      { doc_no: 'HC-SO-000001', company_id: 1 },
      { doc_no: '2990-SO-2607-023', company_id: '2' },
      { doc_no: 'HC-SO-000002', company_id: 1 },
      { doc_no: 'NO-COMPANY', company_id: null },
      { doc_no: null, company_id: 1 },
    ]);
    expect(walk).toHaveBeenCalledTimes(2);
    expect(walk).toHaveBeenCalledWith({}, ['HC-SO-000001', 'HC-SO-000002'], 1);
    expect(walk).toHaveBeenCalledWith({}, ['2990-SO-2607-023'], 2);
    expect(out.get('HC-SO-000001')).toEqual(['PO-1-HC-SO-000001']);
    expect(out.get('2990-SO-2607-023')).toEqual(['PO-2-2990-SO-2607-023']);
    expect(out.has('NO-COMPANY')).toBe(false);
  });

  test('no rows means no walk', async () => {
    walk.mockClear();
    expect((await planningPoNosByDoc({}, [])).size).toBe(0);
    expect(walk).not.toHaveBeenCalled();
  });
});
