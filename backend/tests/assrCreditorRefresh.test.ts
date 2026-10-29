import { describe, expect, test } from 'vitest';
import { patchAssrCase, FIELD_LOG_ALLOW } from '../src/services/assr';

// HC-0130: correcting the SO number re-resolves the Supplier even when the PATCH
// carries no item_code (and when the old doc_no was blank). The resolver's first
// read is `SELECT * FROM assr_cases ... LIMIT 1`, and it only runs with an item code.
function fakeEnv(snapshot: Record<string, unknown>) {
  const sqls: string[] = [];
  const stmt = (sql: string) => ({
    bind() {
      return {
        async first() {
          sqls.push(sql);
          if (/SELECT doc_no FROM assr_cases/.test(sql)) return { doc_no: snapshot.doc_no ?? null };
          if (/FROM assr_cases WHERE id = \? LIMIT 1/.test(sql)) return { id: 7, creditor_code: null, creditor_source: null, doc_no: 'NEW', company_id: 1 };
          if (/FROM assr_cases WHERE id/.test(sql)) return snapshot;
          return null;
        },
        async all() { sqls.push(sql); return { results: [] }; },
        async run() { sqls.push(sql); return { success: true, meta: { changes: 1 } }; },
      };
    },
    async all() { sqls.push(sql); return { results: [] }; },
  });
  return { env: { DB: { prepare: stmt, batch: async (s: unknown[]) => s.map(() => ({ success: true })) } } as any, sqls };
}

describe('patchAssrCase re-resolves the Supplier on an SO-number change', () => {
  test.each([['OLD'], [null]])('old doc_no %s, no item_code in body: resolver runs with the case item', async (old) => {
    const { env, sqls } = fakeEnv({ doc_no: old, item_code: 'MAT-1' });
    await patchAssrCase(env, 7, { doc_no: 'NEW' }, 1);
    expect(sqls.some((q) => /FROM assr_cases WHERE id = \? LIMIT 1/.test(q))).toBe(true);
  });
  test('an unrelated edit does not call the resolver', async () => {
    const { env, sqls } = fakeEnv({ doc_no: 'OLD', item_code: 'MAT-1' });
    await patchAssrCase(env, 7, { customer_name: 'X' }, 1);
    expect(sqls.some((q) => /FROM assr_cases WHERE id = \? LIMIT 1/.test(q))).toBe(false);
  });
});

describe('Timeline', () => {
  test('Root Cause edits are logged', () => expect(FIELD_LOG_ALLOW.has('verified_root_cause')).toBe(true));
});
