import { describe, expect, it } from 'vitest';
import { confirmInTurn, confirmSummary } from './batch-confirm';

describe('confirmInTurn', () => {
  it('goes through the rows one after another and a refusal does not stop the rest', async () => {
    const order: string[] = [];
    const out = await confirmInTurn(['A', 'B', 'C', 'D'], (r) => r, async (r) => {
      order.push(`start ${r}`);
      await Promise.resolve();
      order.push(`end ${r}`);
      if (r === 'B') throw new Error('Already billed');
      return r === 'C' ? 'Stock was not received' : null;
    });
    expect(order).toEqual(['start A', 'end A', 'start B', 'end B', 'start C', 'end C', 'start D', 'end D']);
    expect(out.done).toEqual(['A', 'D']);
    expect(out.failed).toEqual([{ doc: 'B', reason: 'Already billed' }, { doc: 'C', reason: 'Stock was not received' }]);
  });
});

describe('confirmSummary', () => {
  it('counts against what was ticked and names each one left behind', () => {
    expect(confirmSummary('goods receipt', { done: ['A', 'B'], failed: [] })).toMatchObject({ title: '2 of 2 confirmed', tone: 'info' });
    const s = confirmSummary('goods receipt', { done: ['A'], failed: [{ doc: 'B', reason: 'No lines' }] });
    expect(s).toMatchObject({ title: '1 of 2 confirmed', tone: 'error' });
    expect(s.body).toContain('B: No lines');
  });
});
