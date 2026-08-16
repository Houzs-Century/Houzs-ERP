/* paginateAll's stopping conditions, and the one it used to keep to itself.
 *
 * It stops for two reasons that mean opposite things: a SHORT page (that was all
 * the data) and MAX_PAGES (there is more, this is a slice). Until 2026-08-16 the
 * second was indistinguishable from the first — same `{data, error}`, no flag —
 * so a caller that must not plan on a slice had nothing to check, and routes/mrp.ts
 * checked a number the transport could never reach instead. `truncated` is that
 * missing bit; PAGINATE_CEILING is the only bound a caller's own guard may be
 * compared against.
 */
import { describe, expect, test } from 'vitest';
import { paginateAll, chunkIn, PAGINATE_CEILING } from './paginate-all';

const PAGE = 1000;

/** A page source holding `total` rows, capping each response at `cap` rows the
 *  way PostgREST's db-max-rows does, and counting the requests it serves. */
function source(total: number, cap = PAGE) {
  const calls: Array<[number, number]> = [];
  const run = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to, from + cap - 1, total - 1);
    const rows = Array.from({ length: Math.max(0, end - from + 1) }, (_, i) => ({ i: from + i }));
    return Promise.resolve({ data: rows, error: null });
  };
  return { run, calls };
}

describe('paginateAll', () => {
  test('reads every row of a set that spans several pages', async () => {
    const s = source(2500);
    const { data, error, truncated } = await paginateAll<{ i: number }>(s.run);
    expect(error).toBeNull();
    expect(data).toHaveLength(2500);
    expect(data?.[2499].i).toBe(2499);
    expect(truncated).toBe(false);
    expect(s.calls).toHaveLength(4); // 1000 + 1000 + 500 + the empty one that ends it
  });

  test('an exact multiple of the page size costs one extra request, not a lost row', async () => {
    const s = source(2000);
    const { data, truncated } = await paginateAll<{ i: number }>(s.run);
    expect(data).toHaveLength(2000);
    expect(truncated).toBe(false);
    expect(s.calls).toHaveLength(3); // the third comes back empty and stops it
  });

  test('a server capping BELOW the page size is read in full, not stopped after one response', async () => {
    /* The assumption this module used to make and could not check. With a cap of
       400 and a stop-on-short-page walk, the first response looks like the end of
       the data and 2100 of 2500 rows vanish — silently, which is the whole point.
       Advancing by rows RECEIVED reads all 2500 whatever the cap is. */
    const s = source(2500, 400);
    const { data, truncated } = await paginateAll<{ i: number }>(s.run);
    expect(data).toHaveLength(2500);
    expect(data?.[2499].i).toBe(2499);
    expect(truncated).toBe(false);
    // Windows must tile the set with no hole and no overlap.
    expect(s.calls.map(([from]) => from)).toEqual([0, 400, 800, 1200, 1600, 2000, 2400, 2500]);
  });

  test('running out of pages reports truncated instead of pretending it finished', async () => {
    // One row more than the ceiling: every page is full, the loop runs out.
    const s = source(PAGINATE_CEILING + 1);
    const { data, error, truncated } = await paginateAll<{ i: number }>(s.run);
    expect(error).toBeNull();
    expect(data).toHaveLength(PAGINATE_CEILING);
    expect(truncated).toBe(true);
  });

  test('exactly the ceiling reports truncated, because it cannot know otherwise', async () => {
    /* The boundary, and the deliberate answer at it. A set of exactly
       PAGINATE_CEILING rows stops the walk before it ever sees the empty
       response that would prove there is nothing more, so `truncated` here means
       "stopped at my bound; completeness UNVERIFIED" and it errs toward the
       alarm. The two mistakes are not symmetric: a false alarm on a 50,000-row
       read is a 500 on a page already far past its design size, while a false
       all-clear is the silent wrong plan this flag exists to prevent. */
    const s = source(PAGINATE_CEILING);
    const { data, truncated } = await paginateAll<{ i: number }>(s.run);
    expect(data).toHaveLength(PAGINATE_CEILING);
    expect(truncated).toBe(true);
  });

  test('an error stops the walk and is handed back', async () => {
    let n = 0;
    const { data, error, truncated } = await paginateAll(() => {
      n += 1;
      return Promise.resolve(n === 1
        ? { data: Array.from({ length: PAGE }, () => ({})), error: null }
        : { data: null, error: { message: 'boom', code: '42703' } });
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42703');
    expect(truncated).toBe(false); // an error is not a slice — do not conflate them
    expect(n).toBe(2);
  });
});

describe('chunkIn', () => {
  test('splits the IN list, pages each chunk, and merges', async () => {
    const seen: string[][] = [];
    const { data, error, truncated } = await chunkIn<{ code: string }>(
      Array.from({ length: 450 }, (_, i) => `C${i}`),
      (batch, from) => {
        if (from === 0) seen.push(batch);
        return Promise.resolve({ data: from === 0 ? batch.map((code) => ({ code })) : [], error: null });
      },
    );
    expect(error).toBeNull();
    expect(truncated).toBe(false);
    expect(seen.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(data).toHaveLength(450);
  });

  test('a truncated chunk truncates the whole result', async () => {
    const { truncated } = await chunkIn(['A'], (_batch, from, to) =>
      Promise.resolve({ data: Array.from({ length: to - from + 1 }, () => ({})), error: null }));
    expect(truncated).toBe(true);
  });
});
