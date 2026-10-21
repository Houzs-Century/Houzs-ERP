// HC-0130: the auto-resolver's "creditor_resolved" trail row named a
// created_by column that assr_activity does not have, so every insert failed
// and was swallowed: no case showed when or from where its supplier came. The
// fake DB refuses an assr_activity column the real table lacks.
import { describe, expect, test } from 'vitest';
import { resolveCreditorForCase } from './stockItems';
import type { Env } from '../types';

const ACTIVITY_COLS = new Set([
  'id', 'assr_id', 'action', 'from_value', 'to_value', 'note', 'user_id', 'category', 'created_at',
  'stage_elapsed_days', 'stage_target_days', 'source_channel', 'references_entry_id', 'is_correction',
]);

function fakeEnv(inserted: Array<unknown[]>) {
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (sql.includes('FROM assr_cases')) return { creditor_code: null, creditor_source: null, doc_no: 'HC-SO-1', company_id: 1 };
          if (sql.includes('FROM stock_items')) return { item_code: 'MAT-1', main_supplier: '400-D002' };
          return null;
        },
        async run() {
          const m = sql.match(/INSERT INTO assr_activity \(([^)]*)\)/);
          if (m) {
            const bad = m[1].split(',').map((c) => c.trim()).filter((c) => !ACTIVITY_COLS.has(c));
            if (bad.length) throw new Error(`column ${bad.join(', ')} does not exist`);
            inserted.push(args);
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB } as unknown as Env;
}

describe('resolveCreditorForCase activity trail', () => {
  test('writes a creditor_resolved row the real assr_activity table accepts', async () => {
    const inserted: Array<unknown[]> = [];
    expect(await resolveCreditorForCase(fakeEnv(inserted), 5, 'MAT-1')).toBe('400-D002');
    expect(inserted).toEqual([[5, null, '400-D002', 'Auto-resolved from item MAT-1']]);
  });
});
