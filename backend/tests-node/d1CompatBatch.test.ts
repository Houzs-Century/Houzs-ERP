import { describe, expect, test, vi } from 'vitest';
import type { Sql } from 'postgres';
import { d1Compat } from '../src/db/d1-compat';

describe('D1 compatibility batch transaction', () => {
  test('every batch statement executes on the transaction connection, never the root client', async () => {
    const rootUnsafe = vi.fn(async () => { throw new Error('escaped transaction'); });
    const txUnsafe = vi.fn(async () => []);
    const tx = { unsafe: txUnsafe } as unknown as Sql;
    const root = {
      unsafe: rootUnsafe,
      begin: async (callback: (sql: Sql) => Promise<unknown>) => callback(tx),
    } as unknown as Sql;
    const db = d1Compat(() => root);
    const first = db.prepare('UPDATE first_table SET value=? WHERE id=?').bind('a', 1);
    const second = db.prepare('DELETE FROM second_table WHERE id=?').bind(2);

    await db.batch([first, second]);

    expect(rootUnsafe).not.toHaveBeenCalled();
    expect(txUnsafe).toHaveBeenNthCalledWith(1, 'UPDATE first_table SET value=$1 WHERE id=$2', ['a', 1]);
    expect(txUnsafe).toHaveBeenNthCalledWith(2, 'DELETE FROM second_table WHERE id=$1', [2]);
  });

  test('a transaction statement failure rejects the whole batch', async () => {
    const txUnsafe = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('injected D1-compatible failure'));
    const tx = { unsafe: txUnsafe } as unknown as Sql;
    const root = {
      unsafe: vi.fn(),
      begin: async (callback: (sql: Sql) => Promise<unknown>) => callback(tx),
    } as unknown as Sql;
    const db = d1Compat(() => root);

    await expect(db.batch([
      db.prepare('UPDATE a SET value=?').bind(1),
      db.prepare('UPDATE b SET value=?').bind(2),
    ])).rejects.toThrow(/injected D1-compatible failure/);
  });
});
