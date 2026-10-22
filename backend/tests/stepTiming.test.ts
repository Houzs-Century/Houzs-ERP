import { describe, expect, it } from 'vitest';
import { stepClock, stepTimingEntries, timed, withStepTiming, type StepMark } from '../src/lib/step-timing';

/* HC-0002: steps a handler times reach the request's Server-Timing header;
   outside a request (tests, cron) the helpers only run the work. */
describe('step timing', () => {
  it('records each timed step under the current request', async () => {
    const marks: StepMark[] = [];
    const out = await withStepTiming(marks, async () => {
      const a = await timed('inv-totals', async () => 1);
      const b = await timed('inv-demand', async () => 2);
      return a + b;
    });
    expect(out).toBe(3);
    expect(marks.map((m) => m.name)).toEqual(['inv-totals', 'inv-demand']);
  });

  it('keeps the steps of overlapping requests apart', async () => {
    const a: StepMark[] = [];
    const b: StepMark[] = [];
    await Promise.all([
      withStepTiming(a, () => timed('a-step', () => new Promise((r) => setTimeout(r, 5)))),
      withStepTiming(b, () => timed('b-step', () => new Promise((r) => setTimeout(r, 1)))),
    ]);
    expect(a.map((m) => m.name)).toEqual(['a-step']);
    expect(b.map((m) => m.name)).toEqual(['b-step']);
  });

  it('records a step that rejects, and the rejection still reaches the caller', async () => {
    const marks: StepMark[] = [];
    await expect(withStepTiming(marks, () => timed('boom', async () => { throw new Error('x'); }))).rejects.toThrow('x');
    expect(marks.map((m) => m.name)).toEqual(['boom']);
  });

  it('runs the work as a plain call outside a request', async () => {
    await expect(timed('cron', async () => 'done')).resolves.toBe('done');
    const lap = stepClock();
    expect(() => lap('no-request')).not.toThrow();
  });

  it('laps record the time since the previous lap', async () => {
    const marks: StepMark[] = [];
    await withStepTiming(marks, async () => {
      const lap = stepClock();
      lap('first');
      lap('second');
    });
    expect(marks.map((m) => m.name)).toEqual(['first', 'second']);
  });

  it('sums repeats per name, slowest first, as header-safe tokens', () => {
    const entries = stepTimingEntries([
      { name: 'dp-items', ms: 30 },
      { name: 'dp so headers', ms: 900 },
      { name: 'dp-items', ms: 20 },
    ]);
    expect(entries).toEqual([
      's-dp_so_headers;dur=900;desc="1x"',
      's-dp-items;dur=50;desc="2x"',
    ]);
  });
});
