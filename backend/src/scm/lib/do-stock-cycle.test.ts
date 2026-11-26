import { describe, expect, test } from 'vitest';
import { reshipAfterRevert, retireDoStockCycle } from './do-stock-cycle';


function db(opts: { reversals: number; readError?: string; retireError?: string }) {
  const calls: string[] = [];
  return {
    calls,
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => (opts.readError ? { count: null, error: { message: opts.readError } } : { count: opts.reversals, error: null }),
        }),
      }),
    }),
    rpc: async (name: string) => {
      calls.push(name);
      return { error: opts.retireError ? { message: opts.retireError } : null };
    },
  };
}

describe('reshipAfterRevert', () => {
  test('an OUT with no reversal is a live ship: no-op, nothing retired', async () => {
    const d = db({ reversals: 0 });
    expect(await reshipAfterRevert(d, 'do-1')).toBe('shipped');
    expect(d.calls).toEqual([]);
  });

  test('an OUT whose stock a revert returned is retired and the ship deducts again', async () => {
    const d = db({ reversals: 2 });
    expect(await reshipAfterRevert(d, 'do-1')).toBe('deduct');
    expect(d.calls).toEqual(['fn_retire_do_stock_cycle']);
  });

  test('a refused retire is said, never read as clean', async () => {
    const r = await reshipAfterRevert(db({ reversals: 1, retireError: 'still out' }), 'do-1');
    expect(r).toContain('Stock was NOT taken out');
    expect(r).toContain('still out');
  });

  test('a failed reversal read refuses instead of guessing', async () => {
    const r = await reshipAfterRevert(db({ reversals: 0, readError: 'timeout' }), 'do-1');
    expect(r).toContain('Could not check');
  });
});

describe('retireDoStockCycle', () => {
  test('a thrown rpc becomes a reason, not an exception', async () => {
    const r = await retireDoStockCycle({ rpc: () => Promise.reject(new Error('down')) }, 'do-1');
    expect(r).toBe('down');
  });
});
