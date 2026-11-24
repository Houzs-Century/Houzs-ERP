/* postgres.js parses a `date` column (OID 1082) into a JS Date; PostgREST
 * returns "YYYY-MM-DD". Code written for PostgREST then did
 * String(cost_day).slice(0, 10) inside the transaction and got "Tue Nov 24",
 * so a sofa set changed twice after its opening day was costed on the wrong day
 * (so-set-change-cost.ts). The shim now returns date columns as PostgREST does. */
import { describe, expect, test } from 'vitest';
import { pgTransactionSupabase } from './pg-supabase-transaction';

function fakeSql(rows: Record<string, unknown>[], columns: Array<{ name: string; type: number }>) {
  const sql = {
    unsafe: async (text: string) => {
      if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(text)) return [];
      return Object.assign([...rows], { columns });
    },
    json: (v: unknown) => v,
    typed: (v: unknown) => v,
  };
  // eslint-disable-next-line no-restricted-syntax -- a test double for postgres.js Sql: the shim calls only unsafe / json / typed
  return pgTransactionSupabase(sql as never);
}

describe('pgTransactionSupabase: date columns read back as PostgREST text', () => {
  test('a date column comes back as YYYY-MM-DD, null stays null', async () => {
    const sb = fakeSql(
      [{ id: 'l1', cost_day: new Date('2026-11-24'), set_cost_day: null }],
      [{ name: 'id', type: 2950 }, { name: 'cost_day', type: 1082 }, { name: 'set_cost_day', type: 1082 }],
    );
    const { data } = await sb.from('mfg_sales_order_items').select('id, cost_day, set_cost_day').eq('id', 'l1');
    expect(data).toEqual([{ id: 'l1', cost_day: '2026-11-24', set_cost_day: null }]);
    expect(String((data as Array<{ cost_day: unknown }>)[0]!.cost_day).slice(0, 10)).toBe('2026-11-24');
  });

  test('a timestamptz column is left as the driver gives it', async () => {
    const at = new Date('2026-11-24T04:07:48.120Z');
    const sb = fakeSql([{ updated_at: at }], [{ name: 'updated_at', type: 1184 }]);
    const { data } = await sb.from('so_amendments').select('updated_at').eq('id', 'a1').maybeSingle();
    expect((data as { updated_at: unknown }).updated_at).toBe(at);
  });
});
