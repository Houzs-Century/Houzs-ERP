import { describe, expect, it, vi } from 'vitest';
import { loggedStepClock, recordStep, stepClock, stepTimingEntries, timed, withStepTiming, type StepMark } from '../src/lib/step-timing';
import { pgTransactionSupabase } from '../src/scm/lib/pg-supabase-transaction';

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

  it('database round trips recorded by the clients count per request', async () => {
    const marks: StepMark[] = [];
    await withStepTiming(marks, async () => {
      recordStep('db-rest', 40);
      recordStep('db-rest', 60);
      recordStep('db-sql', 5);
    });
    expect(stepTimingEntries(marks)).toEqual(['s-db-rest;dur=100;desc="2x"', 's-db-sql;dur=5;desc="1x"']);
    expect(() => recordStep('db-sql', 1)).not.toThrow();
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

  /* HC-0167: an approve the browser gave up on never sends Server-Timing, so
     each lap is logged as it happens, with the database steps since the last. */
  it('logged laps write each step with its database round trips as they happen', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const marks: StepMark[] = [];
    await withStepTiming(marks, async () => {
      const lap = loggedStepClock('approve-so a1', 'db-pg');
      recordStep('db-pg', 30);
      recordStep('db-pg', 20);
      recordStep('db-rest', 99);
      lap('claim');
      recordStep('db-pg', 7);
      lap('apply');
    });
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[approve-so a1\] claim \d+ms total=\d+ms db-pg=2x\/50ms$/);
    expect(lines[1]).toMatch(/^\[approve-so a1\] apply \d+ms total=\d+ms db-pg=1x\/7ms$/);
    expect(marks.filter((m) => m.name === 'claim' || m.name === 'apply')).toHaveLength(2);
  });

  it('each statement of an SCM command counts as one db-pg step', async () => {
    const sql = { unsafe: async () => [] } as unknown as Parameters<typeof pgTransactionSupabase>[0];
    const marks: StepMark[] = [];
    await withStepTiming(marks, async () => {
      const sb = pgTransactionSupabase(sql);
      await sb.from('so_amendments').select('id').eq('id', 'a1').maybeSingle();
      await sb.from('mfg_sales_orders').update({ version: 2 }).eq('doc_no', 'SO-1');
    });
    expect(marks.filter((m) => m.name === 'db-pg')).toHaveLength(2);
  });
});
