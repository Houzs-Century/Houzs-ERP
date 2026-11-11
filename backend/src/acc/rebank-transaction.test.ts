/* The switch and the transaction client the atomic receipt move writes through.
 *
 * The client is pgTransactionSupabase (the runScmPgCommand shim) plus what the
 * journal engine needs and the shim did not have: `.like` and `.schema('public')`
 * (nextJeNo's floor read and jePrefixForCompany's companies read) and the JE
 * number counter RPC. Driven over a recording stand-in for postgres.js: a
 * statement shape the engine relies on that is not emitted fails here.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { rebankMode, rebankTxClient, rebankTxFor } from './rebank-transaction';

function recordingSql(answer: (text: string) => unknown[]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const unsafe = async (text: string, values: unknown[] = []) => {
    statements.push({ text, values });
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(text)) return [];
    return answer(text);
  };
  return { sql: { unsafe } as unknown as Sql, statements };
}

describe('RECEIPT_REBANK_MODE', () => {
  it('is atomic unless it says two-step', () => {
    expect(rebankMode({})).toBe('atomic');
    expect(rebankMode({ RECEIPT_REBANK_MODE: 'atomic' })).toBe('atomic');
    expect(rebankMode({ RECEIPT_REBANK_MODE: 'typo' })).toBe('atomic');
    expect(rebankMode({ RECEIPT_REBANK_MODE: ' Two-Step ' })).toBe('two-step');
    expect(rebankTxFor({ RECEIPT_REBANK_MODE: 'two-step' })).toBeNull();
  });

  it('atomic with no database configured refuses, and never runs the writes outside a transaction', async () => {
    const tx = rebankTxFor({ DATABASE_URL: '' });
    expect(tx).not.toBeNull();
    let ran = false;
    await expect(tx!(async () => { ran = true; return 1; })).rejects.toThrow(/PostgreSQL transaction service is not configured/);
    expect(ran).toBe(false);
  });
});

describe('the transaction client', () => {
  it('reads the companies master in public, and the JE floor with LIKE, on the transaction', async () => {
    const { sql, statements } = recordingSql((text) => (text.includes('"companies"') ? [{ code: 'HOUZS' }] : [{ je_no: 'JE-2610-0007' }]));
    const db = rebankTxClient(sql);
    const co = await db.schema('public').from('companies').select('code').eq('id', 1).maybeSingle();
    expect(co.data).toEqual({ code: 'HOUZS' });
    const floor = await db.from('journal_entries').select('je_no').like('je_no', 'JE-2610-%').order('je_no', { ascending: false }).limit(1);
    expect(floor.data).toEqual([{ je_no: 'JE-2610-0007' }]);
    const real = statements.filter((s) => !/SAVEPOINT/.test(s.text));
    expect(real.map((s) => s.text)).toEqual([
      'SELECT "code" FROM public."companies" WHERE "id" = $1',
      'SELECT "je_no" FROM scm."journal_entries" WHERE "je_no" LIKE $1 ORDER BY "je_no" DESC LIMIT $2',
    ]);
    expect(real[1]!.values).toEqual(['JE-2610-%', 1]);
  });

  it('claims the JE number from the counter on the transaction (the shared shim refuses that RPC)', async () => {
    const { sql, statements } = recordingSql((text) => (text.includes('next_doc_no_n') ? [{ n: 8 }] : []));
    const r = await rebankTxClient(sql).rpc('next_doc_no_n', { p_series: 'JE-2610', p_floor: 7 });
    expect(r).toEqual({ data: 8, error: null });
    expect(statements.at(-1)).toEqual({ text: 'SELECT scm.next_doc_no_n($1::text, $2::integer) AS n', values: ['JE-2610', 7] });
    await expect(rebankTxClient(sql).rpc('something_else', {})).rejects.toThrow(/Unsupported SCM transaction RPC/);
  });

  it('names only the two schemas it knows', () => {
    const { sql } = recordingSql(() => []);
    expect(() => rebankTxClient(sql).schema('auth')).toThrow(/Unsupported SCM transaction schema/);
  });
});
