/* The amend-reason pick list (owner 2026-11-27): the dropdown shows only ACTIVE
   reasons, ordered by sort_order then label. pickActiveReasonLabels is the pure
   core of useAmendReasonOptions, so the ordering + active filter is tested here
   without react-query. */
import { describe, expect, test } from 'vitest';
import { pickActiveReasonLabels, type AmendReasonRow } from './delivery-amend-reasons-queries';

const row = (o: Partial<AmendReasonRow> & { label: string }): AmendReasonRow => ({
  id: o.label, label: o.label, sortOrder: o.sortOrder ?? 0, isActive: o.isActive ?? true,
});

describe('pickActiveReasonLabels', () => {
  test('keeps only active reasons, ordered by sortOrder', () => {
    const rows = [
      row({ label: 'Third', sortOrder: 30 }),
      row({ label: 'First', sortOrder: 10 }),
      row({ label: 'Hidden', sortOrder: 20, isActive: false }),
      row({ label: 'Second', sortOrder: 25 }),
    ];
    expect(pickActiveReasonLabels(rows)).toEqual(['First', 'Second', 'Third']);
  });

  test('breaks a sortOrder tie by label, and never mutates the input', () => {
    const rows = [row({ label: 'Bravo', sortOrder: 10 }), row({ label: 'Alpha', sortOrder: 10 })];
    const snapshot = rows.map((r) => r.label);
    expect(pickActiveReasonLabels(rows)).toEqual(['Alpha', 'Bravo']);
    expect(rows.map((r) => r.label)).toEqual(snapshot);
  });

  test('an empty list yields no options (a removed reason stays removed)', () => {
    expect(pickActiveReasonLabels([])).toEqual([]);
  });
});
