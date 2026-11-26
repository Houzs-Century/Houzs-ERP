import { describe, it, expect } from 'vitest';
import { findOverInvoicedDoItems } from './do-line-remaining';

describe('findOverInvoicedDoItems', () => {
  it('passes a line that still has room', () => {
    expect(findOverInvoicedDoItems(['a'], new Map([['a', 3]]))).toEqual([]);
  });

  it('passes a line that is exactly used up', () => {
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
    expect(findOverInvoicedDoItems(['gone'], new Map())).toEqual([]);
  });

  it('does not double-report an id passed twice', () => {
    expect(findOverInvoicedDoItems(['a', 'a'], new Map([['a', -3]])))
      .toEqual([{ doItemId: 'a', over: 3 }]);
  });
});
