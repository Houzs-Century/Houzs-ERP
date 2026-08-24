import { describe, expect, test } from 'vitest';
import { chunkIn } from '../src/scm/lib/paginate-all';

/* WHY THIS EXISTS. chunkIn batched correctly and ran the batches one after
   another. Measured on production 2026-08-18: sizing batches by URL bytes took
   them from 200 values to 76, so the same work became 2.6x as many SERIAL round
   trips and the SO list went 2450ms -> ~5900ms. The chunking was right; the
   serialism was the cost.
   These assert the two properties that make the parallel form a drop-in — the
   ANSWER is unchanged, and the batches genuinely overlap — so a future edit
   cannot quietly put the `for` loop back. */
describe('chunkIn', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `id-${String(i).padStart(4, '0')}`);

  test('merged rows come back in INPUT order, not completion order', async () => {
    /* Later batches resolve FIRST here. A form that concatenated on completion
       would interleave; input order is what several callers rely on. */
    const seenBatches: string[][] = [];
    const { data, error } = await chunkIn<{ id: string }>(ids, async (batch) => {
      seenBatches.push([...batch]);
      const delay = 40 - seenBatches.length * 2;
      await new Promise((r) => setTimeout(r, Math.max(0, delay)));
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(error).toBeNull();
    expect(data.map((r) => r.id)).toEqual(ids);
  });

  test('batches OVERLAP — the whole point of the change', async () => {
    let inFlight = 0;
    let peak = 0;
    await chunkIn<{ id: string }>(ids, async (batch) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { data: batch.map((id) => ({ id })), error: null };
    }, 25); // 20 batches, so a serial form could only ever peak at 1
    // serial would peak at exactly 1; unbounded would peak at the batch count
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  test('the FIRST failing batch in input order wins, and earlier rows are kept', async () => {
    /* The sequential form returned at the first failure with everything merged
       so far. Later batches now run before that is known — which costs a
       discarded result, never a wrong one. */
    const SIZE = 100; // explicit: chunkSizeForUrl depends on id WIDTH, and a
                      // test that hard-codes the derived number breaks when an
                      // unrelated budget changes
    const { data, error } = await chunkIn<{ id: string }>(ids, async (batch) => {
      if (batch[0] === ids[0]) return { data: batch.map((id) => ({ id })), error: null };
      if (batch[0] === ids[SIZE]) return { data: null, error: { message: 'boom' } };
      await new Promise((r) => setTimeout(r, 5));
      return { data: batch.map((id) => ({ id })), error: null };
    }, SIZE);
    expect(error?.message).toBe('boom');
    expect(data).toHaveLength(SIZE);
    expect(data[0]!.id).toBe(ids[0]);
  });

  test('an empty id list issues no query at all', async () => {
    let calls = 0;
    const { data, error } = await chunkIn<{ id: string }>([], async (batch) => {
      calls += 1;
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(calls).toBe(0);
    expect(data).toEqual([]);
    expect(error).toBeNull();
  });
});
