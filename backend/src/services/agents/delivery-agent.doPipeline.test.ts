import { describe, expect, test } from 'vitest';
import { collectDoStatusCounts } from './delivery-agent';


type Page = { data: Array<{ status: string | null }> | null; error: { message: string } | null };

function fakeSb(page: Page, spy?: { selects: string[]; filters: string[] }) {
  return {
    from() {
      return {
        select(cols: string) {
          spy?.selects.push(cols);
          const builder = {
            eq(col: string, val: string) { spy?.filters.push(`${col}=${val}`); return builder; },
            range() { return Promise.resolve(page); },
            then(res: (p: Page) => unknown) { return Promise.resolve(page).then(res); },
          };
          return builder;
        },
      };
    },
  };
}

describe('collectDoStatusCounts', () => {
  test('a failed read is reported, NEVER served as an empty pipeline', async () => {
    const read = await collectDoStatusCounts(
      fakeSb({ data: null, error: { message: 'invalid input value for enum do_status: "COMPLETED"' } }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('do_status');
  });

  test('counts every status the ROWS actually carry, including ones no vocabulary lists', async () => {
    const read = await collectDoStatusCounts(fakeSb({
      data: [
        { status: 'DELIVERED' }, { status: 'DELIVERED' },
        { status: 'IN_TRANSIT' },
        { status: 'legacy_spelling' },
        { status: null },
      ],
      error: null,
    }));
    expect(read).toEqual({
      ok: true,
      byStatus: { DELIVERED: 2, IN_TRANSIT: 1, LEGACY_SPELLING: 1, UNKNOWN: 1 },
    });
  });

  test('no status LITERAL is sent to Postgres — the enum is never asked to parse one', async () => {
    const spy = { selects: [] as string[], filters: [] as string[] };
    await collectDoStatusCounts(fakeSb({ data: [{ status: 'DRAFT' }], error: null }, spy));
    expect(spy.filters).toEqual([]);
    expect(spy.selects).toEqual(['status']);
  });

  test('a genuinely empty table is zero deliveries, not a failure', async () => {
    const read = await collectDoStatusCounts(fakeSb({ data: [], error: null }));
    expect(read).toEqual({ ok: true, byStatus: {} });
  });
});
