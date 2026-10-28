import { describe, expect, test, vi } from 'vitest';
import {
  claimDocNoSuffix,
  mintMonthlyDocNo,
  nextMonthlyDocNo,
  DOC_NO_COUNTER_RPC,
} from '../src/scm/lib/doc-no';

/* The counter's DEGRADATION BOUNDARY — where mintMonthlyDocNo is allowed to go
 * back to max(suffix)+1, and where it must refuse instead.
 *
 * This is the assertion that keeps the fix honest. `scm.next_doc_no_n` is the
 * authority for document numbers (migration 0316), and the whole point of it is
 * that a delete can no longer hand a number back. A fallback taken on a REAL
 * failure would quietly restore that bug against a database that had just
 * rejected the atomic path — the exact shape lib/rpc-missing.ts exists to keep
 * precise: *"that fallback is only safe if 'absent' is distinguished from
 * 'failed' with total precision"*.
 *
 * So three things are NOT available, and everything else THROWS:
 *   1. the client has no rpc() at all           — a hand-built test stub
 *   2. PGRST202 / 42883                          — merged but not yet migrated
 *   3. "Unsupported SCM transaction RPC"         — the atomic-command proxy
 *
 * The real counter behaviour is proved against a real server in
 * tests-pg/docNoCounter.pg.test.ts. This file is only about the boundary.
 */

/** Minimal PostgREST-shaped read returning `rows` for the month scan. */
const clientWith = (rows: string[], rpc?: unknown) => ({
  from: () => ({
    select: () => ({
      like: () => ({
        order: () => ({
          range: () => Promise.resolve({ data: rows.map((doc_no) => ({ doc_no })), error: null }),
        }),
      }),
    }),
  }),
  ...(rpc === undefined ? {} : { rpc }),
});

describe('the counter is unavailable — fall back to the pre-counter answer', () => {
  test('a client with no rpc() at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sb = clientWith(['HC-SO-2608-001', 'HC-SO-2608-002']);
    expect(await claimDocNoSuffix(sb, 'HC-SO-2608', 2)).toBeNull();
    // …and the mint returns exactly what shipped before the counter existed.
    const got = await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2608');
    expect(got).toBe(nextMonthlyDocNo('HC-SO-2608', ['HC-SO-2608-001', 'HC-SO-2608-002']));
    expect(got).toBe('HC-SO-2608-003');
    // It is never SILENT: the re-issue exposure is back until the migration applies.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/unavailable/);
    warn.mockRestore();
  });

  test('PGRST202 and 42883 — the function is not in the schema yet', async () => {
    for (const err of [
      { code: 'PGRST202', message: 'Could not find the function scm.next_doc_no_n' },
      { code: '42883', message: 'function scm.next_doc_no_n(text, integer) does not exist' },
    ]) {
      const sb = clientWith([], async () => ({ data: null, error: err }));
      expect(await claimDocNoSuffix(sb, 'HC-SO-2609', 0)).toBeNull();
    }
  });

  test('the atomic-command proxy refusing an RPC outside its whitelist', async () => {
    const sb = clientWith([], async () => {
      throw new Error('Unsupported SCM transaction RPC: next_doc_no_n');
    });
    expect(await claimDocNoSuffix(sb, 'HC-SO-2609', 0)).toBeNull();
  });
});

describe('the counter FAILED — refuse, never fall back', () => {
  test('a real PostgREST error throws and names the RPC', async () => {
    const sb = clientWith(['HC-SO-2608-001'], async () => ({
      data: null,
      error: { code: '40001', message: 'could not serialize access due to concurrent update' },
    }));
    await expect(claimDocNoSuffix(sb, 'HC-SO-2608', 1)).rejects.toThrow(DOC_NO_COUNTER_RPC);
    await expect(mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2608'))
      .rejects.toThrow(/concurrent update/);
  });

  test('a thrown error that is NOT the transaction proxy propagates', async () => {
    const sb = clientWith([], async () => { throw new Error('fetch failed'); });
    await expect(claimDocNoSuffix(sb, 'HC-SO-2609', 0)).rejects.toThrow('fetch failed');
  });

  test('an answer with no usable number is refused, not quietly minted around', async () => {
    for (const data of [null, undefined, {}, [], 'nope', 0, -1]) {
      const sb = clientWith([], async () => ({ data, error: null }));
      await expect(claimDocNoSuffix(sb, 'HC-SO-2609', 0)).rejects.toThrow(/no usable number/);
    }
  });
});

describe('the counter answered — its number wins over the live rows', () => {
  test('a counter ABOVE the live max is used, floor and all', async () => {
    // The book holds HC-SO-2608-001/002 and the ERP was wiped: floor 0, counter 3.
    const sb = clientWith([], async (_name: string, args: Record<string, unknown>) => {
      expect(_name).toBe(DOC_NO_COUNTER_RPC);
      expect(args).toEqual({ p_series: 'HC-SO-2608', p_floor: 0 });
      return { data: 3, error: null };
    });
    // RED, stated: this is what the pre-counter minter answers on the same rows.
    expect(nextMonthlyDocNo('HC-SO-2608', [])).toBe('HC-SO-2608-001');
    expect(await mintMonthlyDocNo(sb, 'mfg_sales_orders', 'doc_no', 'HC-SO-2608'))
      .toBe('HC-SO-2608-003');
  });

  test('the live max is passed as the floor, and a row shape is unwrapped', async () => {
    const sb = clientWith(['HC-PO-2608-001', 'HC-PO-2608-050'], async (_n: string, args: Record<string, unknown>) => {
      expect(args.p_floor).toBe(50);
      return { data: [{ n: 51 }], error: null };
    });
    expect(await mintMonthlyDocNo(sb, 'purchase_orders', 'po_number', 'HC-PO-2608'))
      .toBe('HC-PO-2608-051');
  });

  test('a negative or non-finite floor is clamped to 0 before it leaves', async () => {
    for (const floor of [-5, NaN, Infinity]) {
      const sb = clientWith([], async (_n: string, args: Record<string, unknown>) => {
        expect(args.p_floor).toBe(0);
        return { data: 1, error: null };
      });
      expect(await claimDocNoSuffix(sb, 'HC-SO-2609', floor)).toBe(1);
    }
  });
});
