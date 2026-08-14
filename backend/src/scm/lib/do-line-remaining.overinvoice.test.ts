import { describe, it, expect } from 'vitest';
import { findOverInvoicedDoItems } from './do-line-remaining';

/* The post-insert half of the remaining-to-invoice invariant.
 *
 * The pre-check is read-before-write, so two invoices raised against the same
 * delivered goods can both pass it and bill the customer twice. This runs AFTER
 * the lines are committed, when our own quantity is already counted — so the
 * whole test is "did any line go negative". */
describe('findOverInvoicedDoItems', () => {
  it('passes a line that still has room', () => {
    expect(findOverInvoicedDoItems(['a'], new Map([['a', 3]]))).toEqual([]);
  });

  it('passes a line that is exactly used up', () => {
    // Zero is fully invoiced, not over — the common, correct end state.
    expect(findOverInvoicedDoItems(['a'], new Map([['a', 0]]))).toEqual([]);
  });

  it('reports a negative line, and by how much', () => {
    expect(findOverInvoicedDoItems(['a'], new Map([['a', -2]])))
      .toEqual([{ doItemId: 'a', over: 2 }]);
  });

  it('reports only the offenders when an invoice mixes both', () => {
    const r = new Map([['a', 5], ['b', -1], ['c', 0]]);
    expect(findOverInvoicedDoItems(['a', 'b', 'c'], r))
      .toEqual([{ doItemId: 'b', over: 1 }]);
  });

  it('IGNORES a missing id rather than treating it as over', () => {
    /* Absence means the line resolved to no open figure at all, which the
       pre-check already refused. Treating it as an offence would roll back a
       legitimate invoice whenever a read came back thin — and this guard fires
       when the goods are already delivered. */
    expect(findOverInvoicedDoItems(['gone'], new Map())).toEqual([]);
  });

  it('does not double-report an id passed twice', () => {
    // The caller builds the list from inserted rows; a DO line split across two
    // invoice lines appears twice and must still be ONE conflict.
    expect(findOverInvoicedDoItems(['a', 'a'], new Map([['a', -3]])))
      .toEqual([{ doItemId: 'a', over: 3 }]);
  });
});
