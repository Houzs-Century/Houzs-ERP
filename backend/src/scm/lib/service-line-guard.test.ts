// The SERVICE-line guard exists because a Delivery Return line for a delivery
// fee / dispose / lift would write phantom stock IN. Payload signals catch the
// honest paths; the CATALOG read is what catches a payload that lies about
// both. These tests pin the third case — the read that FAILED — because that is
// the one that used to pass the gate silently (2026-08-13 swallowed-error
// sweep): `const { data } = await q` made a broken lookup indistinguishable
// from "none of these codes are SERVICE".
import { describe, expect, test } from 'vitest';
import { findServiceLineCodes } from './service-line-guard';

/** PostgREST stand-in: `rows` when it works, `error` when it does not. */
const sbWith = (result: { data?: unknown; error?: { message: string } | null }) => ({
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      in: () => b,
      eq: () => b,
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(res),
    };
    return b;
  },
}) as never;

describe('findServiceLineCodes', () => {
  test('a payload that names its own SERVICE group is caught without the catalog', async () => {
    const r = await findServiceLineCodes(sbWith({ data: [] }), [{ itemCode: 'SVC-DELIVERY', itemGroup: 'SERVICE' }], 1);
    expect(r.ok).toBe(true);
    expect(r.ok && r.codes).toEqual(['SVC-DELIVERY']);
  });

  test('a payload that lies about both is caught by the catalog category', async () => {
    const r = await findServiceLineCodes(
      sbWith({ data: [{ code: 'LIFT-01', category: 'SERVICE' }] }),
      [{ itemCode: 'LIFT-01', itemGroup: 'BEDFRAME' }],
      1,
    );
    expect(r.ok && r.codes).toEqual(['LIFT-01']);
  });

  test('honest goods pass', async () => {
    const r = await findServiceLineCodes(
      sbWith({ data: [{ code: 'CODY-(SS)', category: 'BEDFRAME' }] }),
      [{ itemCode: 'CODY-(SS)', itemGroup: 'BEDFRAME' }],
      1,
    );
    expect(r.ok && r.codes).toEqual([]);
  });

  /* THE CLASS. Before the fix this returned [] — the same value as "all clear" —
     and the caller saved the return line. A failed read must never read as an
     absence when the absence is what authorises the write. */
  test('a FAILED catalog read is not "no SERVICE lines"', async () => {
    const r = await findServiceLineCodes(
      sbWith({ error: { message: 'connection reset' } }),
      [{ itemCode: 'LIFT-01', itemGroup: 'BEDFRAME' }],
      1,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('connection reset');
  });

  test('with nothing to look up, no read happens and the verdict stands', async () => {
    const r = await findServiceLineCodes(sbWith({ error: { message: 'would have failed' } }), [], 1);
    expect(r).toEqual({ ok: true, codes: [] });
  });
});
