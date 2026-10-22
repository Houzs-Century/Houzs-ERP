// HC-0117: a slip whose draft SO was discarded (hard-deleted) must not be
// refused as "already uploaded — it created <deleted doc>" on re-scan.
import { describe, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { findRecentSoForSlipSha } from '../src/scm/routes/scan-so';

type Row = Record<string, any>;

/* Honours eq / neq / in / not-null / gte, ignores order / limit. */
function fakeSvc(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
        not: (c: string) => { filters.push((r) => r[c] != null); return q; },
        gte: () => q,
        order: () => q,
        limit: () => q,
        then: (res: any, rej: any) =>
          Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const SHA = 'a'.repeat(64);

describe('findRecentSoForSlipSha (HC-0117)', () => {
  test('a discarded draft is not reported as the original', async () => {
    const svc = fakeSvc({
      so_scan_samples: [{ id: 's1', image_sha256: SHA }],
      scan_jobs: [{ sample_id: 's1', so_doc_no: 'HC-SO-2610-210' }],
      mfg_sales_orders: [],
    });
    expect(await findRecentSoForSlipSha(svc, SHA, null)).toBeNull();
  });

  test('an SO that still exists is reported', async () => {
    const svc = fakeSvc({
      so_scan_samples: [{ id: 's1', image_sha256: SHA }],
      scan_jobs: [{ sample_id: 's1', so_doc_no: 'HC-SO-2610-219' }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-2610-219' }],
    });
    expect(await findRecentSoForSlipSha(svc, SHA, null)).toBe('HC-SO-2610-219');
  });

  test('skips the discarded one and reports a later scan that still exists', async () => {
    const svc = fakeSvc({
      so_scan_samples: [{ id: 's2', image_sha256: SHA }, { id: 's1', image_sha256: SHA }],
      scan_jobs: [
        { sample_id: 's2', so_doc_no: 'HC-SO-2610-210' },
        { sample_id: 's1', so_doc_no: 'HC-SO-2610-219' },
      ],
      mfg_sales_orders: [{ doc_no: 'HC-SO-2610-219' }],
    });
    expect(await findRecentSoForSlipSha(svc, SHA, null)).toBe('HC-SO-2610-219');
  });
});
