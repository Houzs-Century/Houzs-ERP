/* docs/bugs/README.md "A failed read taken as an absence", audit H4: when the DO cancel
 * fallback could not read the DO's stock movements, it built zero reversal rows
 * and answered as if there was nothing to reverse, leaving the shipped stock
 * deducted. An unread list must come back as a movement error. */
import { describe, expect, test } from 'vitest';
import { reverseInventoryForDo } from '../src/scm/routes/delivery-orders-mfg';

type Result = { data?: unknown; count?: number | null; error: { message: string } | null };

function fakeSb(movementsRead: Result) {
  const inserts: unknown[] = [];
  const builder = (table: string) => {
    let head = false;
    const q: Record<string, unknown> = {};
    const result = (): Result => {
      if (table === 'inventory_movements') return head ? { count: 0, error: null } : movementsRead;
      if (table === 'delivery_orders') return { data: { do_number: 'DO-2611-001', warehouse_id: 'wh-1', is_dropship: false, company_id: 1 }, error: null };
      return { data: [], error: null };
    };
    Object.assign(q, {
      select: (_c: string, opts?: { head?: boolean }) => { head = Boolean(opts?.head); return q; },
      eq: () => q,
      in: () => q,
      insert: (rows: unknown) => { inserts.push(rows); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve(result()),
      then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    });
    return q;
  };
  return {
    sb: {
      from: builder,
      rpc: async () => ({ data: null, error: { message: 'function fn_reverse_do_out does not exist' } }),
    },
    inserts,
  };
}

describe('reverseInventoryForDo (DO cancel fallback)', () => {
  test('a failed movements read is reported, not treated as nothing to reverse', async () => {
    const { sb, inserts } = fakeSb({ data: null, error: { message: 'connection reset' } });
    const errors = await reverseInventoryForDo(sb, 'do-1', 'u1');
    expect(errors).toEqual([expect.stringMatching(/could not be read \(connection reset\)/)]);
    expect(inserts.filter((r) => Array.isArray(r))).toEqual([]);
  });

  test('a DO with no movements still reverses nothing and reports nothing', async () => {
    const { sb } = fakeSb({ data: [], error: null });
    expect(await reverseInventoryForDo(sb, 'do-1', 'u1')).toEqual([]);
  });
});
