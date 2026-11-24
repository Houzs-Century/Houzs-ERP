/* HC-0256. Rule 2 (#5956) writes scm.so_product_changes inside the approve-so
 * transaction: before_lines (jsonb) and changed_by / approved_by /
 * amendment_nos / change_types (text[]). The transaction shim knew none of them,
 * threw "Unsupported structured value" on the array, and every later-day
 * product amendment rolled back with "The system hit a problem". This drives the
 * real shim over a capturing fake of postgres.js. */
import { describe, expect, test } from 'vitest';
import { pgTransactionSupabase } from './pg-supabase-transaction';

type Bound = { kind: 'json' | 'typed'; value: unknown; oid?: number };

function fakeSql(reply: Record<string, unknown>[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = {
    unsafe: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return /^(SAVEPOINT|RELEASE|ROLLBACK)/.test(text) ? [] : reply;
    },
    json: (value: unknown): Bound => ({ kind: 'json', value }),
    typed: (value: unknown, oid: number): Bound => ({ kind: 'typed', value, oid }),
  };
  const statement = () => calls.find((c) => !/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(c.text))!;
  // eslint-disable-next-line no-restricted-syntax -- a test double for postgres.js Sql: the shim calls only unsafe / json / typed
  return { sb: pgTransactionSupabase(sql as never), statement };
}

describe('pgTransactionSupabase: scm.so_product_changes columns', () => {
  test('the window baseline upsert binds before_lines as jsonb', async () => {
    const { sb, statement } = fakeSql();
    const { error } = await sb.from('so_product_changes').upsert({
      company_id: 1, so_doc_no: 'HC-SO-1', route: 'AMENDMENT', window_key: 'a1', change_day: '2026-11-24',
      before_lines: [{ id: 'l1', costSen: 100 }],
    }, { onConflict: 'company_id,so_doc_no,route,window_key', ignoreDuplicates: true });
    expect(error).toBeNull();
    expect(statement().values).toContainEqual({ kind: 'json', value: [{ id: 'l1', costSen: 100 }] });
  });

  test('the event write binds the name lists as text[]', async () => {
    const { sb, statement } = fakeSql();
    const { error } = await sb.from('so_product_changes').update({
      changed_by: ['Anthony'], approved_by: ['Sim'], amendment_nos: ['HC-SO-1/A1'], change_types: [],
      lines: [{ id: 'l1' }],
    }).eq('id', 'w1');
    expect(error).toBeNull();
    expect(statement().values.slice(0, 4)).toEqual([
      { kind: 'typed', value: '{"Anthony"}', oid: 1009 },
      { kind: 'typed', value: '{"Sim"}', oid: 1009 },
      { kind: 'typed', value: '{"HC-SO-1/A1"}', oid: 1009 },
      { kind: 'typed', value: '{}', oid: 1009 },
    ]);
  });

  test('a read gives the name lists back as arrays, so a re-read appends instead of spreading a string', async () => {
    const { sb } = fakeSql([{ changed_by: '{"Anthony","Mei Ling"}', approved_by: '{}' }]);
    const { data } = await sb.from('so_product_changes').select('changed_by, approved_by').eq('id', 'w1').maybeSingle();
    expect(data).toEqual({ changed_by: ['Anthony', 'Mei Ling'], approved_by: [] });
  });

  test('approved_by on another table stays a scalar', async () => {
    const { sb, statement } = fakeSql();
    const { error } = await sb.from('payment_requests').update({ approved_by: 'staff-1' }).eq('id', 'p1');
    expect(error).toBeNull();
    expect(statement().values[0]).toBe('staff-1');
  });
});
