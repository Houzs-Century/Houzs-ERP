import { describe, expect, test, vi } from 'vitest';
import type { Sql } from 'postgres';
import { pgTransactionSupabase, settleScmStatements } from '../src/scm/lib/pg-supabase-transaction';

describe('SCM PostgreSQL transaction adapter', () => {
  test('encodes JSON arrays as JSON while preserving native PostgreSQL arrays', async () => {
    const unsafe = vi.fn(async (text: string) => text.startsWith('INSERT') ? [{ id: 'line-1' }] : []);
    const json = vi.fn((value: unknown) => ({ value, type: 3802 }));
    const typed = vi.fn((value: unknown, type: number) => ({ value, type }));
    const sb = pgTransactionSupabase({ unsafe, json, typed } as unknown as Sql);

    const result = await sb.from('mfg_sales_order_items').insert({
      variants: { buildKey: 'B-1' },
      custom_specials: [{ code: 'SPECIAL' }],
      photo_urls: ['so/line/photo.jpg'],
    }).select('id').single();

    expect(result.data).toEqual({ id: 'line-1' });
    const insert = unsafe.mock.calls.find(([text]) => String(text).startsWith('INSERT'));
    expect(insert).toBeDefined();
    expect(json).toHaveBeenNthCalledWith(1, { buildKey: 'B-1' });
    expect(json).toHaveBeenNthCalledWith(2, [{ code: 'SPECIAL' }]);
    expect(typed).toHaveBeenCalledWith('{"so/line/photo.jpg"}', 1009);
    expect(insert?.[1]).toEqual([
      { value: { buildKey: 'B-1' }, type: 3802 },
      { value: [{ code: 'SPECIAL' }], type: 3802 },
      { value: '{"so/line/photo.jpg"}', type: 1009 },
    ]);
  });

  test('unexpected statement errors escape the savepoint and abort the command', async () => {
    const unsafe = vi.fn(async (text: string) => {
      if (text.startsWith('UPDATE')) throw new Error('injected write failure');
      return [];
    });
    const sb = pgTransactionSupabase({ unsafe } as unknown as Sql);

    await expect(sb.from('mfg_sales_orders').update({ status: 'BROKEN' }).eq('doc_no', 'SO-1'))
      .rejects.toThrow(/injected write failure/);
    expect(unsafe.mock.calls.some(([text]) => String(text).startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  test('normalizes text[] returned as a raw literal when fetch_types is disabled', async () => {
    const unsafe = vi.fn(async (text: string) => text.startsWith('SELECT')
      ? [{ photo_urls: '{"so/a\\"quote.jpg","so/back\\\\slash.jpg"}' }]
      : []);
    const sb = pgTransactionSupabase({ unsafe } as unknown as Sql);
    const { data } = await sb.from('mfg_sales_order_items').select('photo_urls').eq('id', 'line-1').maybeSingle();
    expect(data.photo_urls).toEqual(['so/a"quote.jpg', 'so/back\\slash.jpg']);
  });

  test('expected voucher-code collisions remain retryable inside the transaction', async () => {
    const unsafe = vi.fn(async (text: string) => {
      if (text.startsWith('INSERT')) throw new Error('duplicate key value violates unique constraint');
      return [];
    });
    const sb = pgTransactionSupabase({ unsafe } as unknown as Sql);

    const result = await sb.from('pwp_codes').insert({ code: 'DUPLICATE' });
    expect(result.error?.message).toMatch(/duplicate key/);
  });

  test('duplicate mirrored-command idempotency keys remain readable in the transaction', async () => {
    const unsafe = vi.fn(async (text: string) => {
      if (text.startsWith('INSERT')) throw new Error('duplicate key value violates unique constraint sync_command_idempotency_key_key');
      if (text.startsWith('SELECT')) return [{ id: 'existing-command', status: 'PENDING' }];
      return [];
    });
    const json = vi.fn((value: unknown) => ({ value, type: 3802 }));
    const sb = pgTransactionSupabase({ unsafe, json } as unknown as Sql);

    const inserted = await sb.from('sync_command').insert({
      idempotency_key: 'same-decision',
      payload: { action: 'approve-po' },
    }).select('*').single();
    expect(inserted.error?.message).toMatch(/duplicate key/);

    const existing = await sb.from('sync_command')
      .select('id, status')
      .eq('idempotency_key', 'same-decision')
      .maybeSingle();
    expect(existing.data).toEqual({ id: 'existing-command', status: 'PENDING' });
  });

  /* HC-0167: the SAVEPOINT goes out with its statement and the RELEASE with the
     next one, so a statement waits for two answers instead of four. */
  test('each RELEASE is sent before the next statement, and the last is settled before commit', async () => {
    const sent: string[] = [];
    const unsafe = vi.fn(async (text: string) => { sent.push(text.split(' ')[0]!); return []; });
    const sql = { unsafe } as unknown as Sql;
    const sb = pgTransactionSupabase(sql);

    await sb.from('mfg_sales_orders').update({ status: 'A' }).eq('doc_no', 'SO-1');
    await sb.from('mfg_sales_orders').update({ status: 'B' }).eq('doc_no', 'SO-1');
    await settleScmStatements(sql);

    expect(sent).toEqual(['SAVEPOINT', 'UPDATE', 'RELEASE', 'SAVEPOINT', 'UPDATE', 'RELEASE']);
  });

  test('a RELEASE that fails surfaces when it is settled, never silently before COMMIT', async () => {
    const unsafe = vi.fn(async (text: string) => {
      if (text.startsWith('RELEASE')) throw new Error('current transaction is aborted');
      return [];
    });
    const sql = { unsafe } as unknown as Sql;
    await pgTransactionSupabase(sql).from('mfg_sales_orders').update({ status: 'A' }).eq('doc_no', 'SO-1');
    await expect(settleScmStatements(sql)).rejects.toThrow(/aborted/);
    await expect(settleScmStatements(sql)).resolves.toBeUndefined();
  });
});
