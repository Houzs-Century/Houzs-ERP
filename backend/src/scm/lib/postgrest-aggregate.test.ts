import { afterEach, describe, expect, it } from 'vitest';
import { AGG_OFF_MS, readAggregate, resetAggregateMemo } from './postgrest-aggregate';
import { stepTimingEntries, withStepTiming, type StepMark } from '../../lib/step-timing';

afterEach(() => resetAggregateMemo());

const off = { data: null, error: { code: 'PGRST123', message: 'Use of aggregate functions is not allowed' } };

describe('readAggregate', () => {
  it('passes a working aggregate straight through, request every time', async () => {
    let n = 0;
    const run = () => { n += 1; return Promise.resolve({ data: [{ cnt: 3 }], error: null }); };
    expect(await readAggregate(run)).toEqual({ data: [{ cnt: 3 }], error: null });
    expect(await readAggregate(run)).toEqual({ data: [{ cnt: 3 }], error: null });
    expect(n).toBe(2);
  });

  it('remembers PGRST123 for the window, then asks again', async () => {
    let n = 0;
    let t = 1_000;
    const run = () => { n += 1; return Promise.resolve(off); };
    await readAggregate(run, () => t);
    const skipped = await readAggregate(run, () => t + AGG_OFF_MS - 1);
    expect(n).toBe(1);
    expect(skipped.error).toMatchObject({ code: 'PGRST123' });
    t += AGG_OFF_MS;
    await readAggregate(run, () => t);
    expect(n).toBe(2);
  });

  it('does not remember any other error', async () => {
    let n = 0;
    const run = () => { n += 1; return Promise.resolve({ data: null, error: { code: '42703', message: 'column does not exist' } }); };
    await readAggregate(run);
    await readAggregate(run);
    expect(n).toBe(2);
  });

  it('marks the error code and the skip in Server-Timing', async () => {
    const marks: StepMark[] = [];
    await withStepTiming(marks, async () => {
      await readAggregate(() => Promise.resolve(off));
      await readAggregate(() => Promise.resolve(off));
    });
    const header = stepTimingEntries(marks).join(', ');
    expect(header).toContain('s-db-agg-PGRST123');
    expect(header).toContain('s-db-agg-skip');
  });
});
