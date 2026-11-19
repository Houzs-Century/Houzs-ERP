/* The event a payment request's bill points at (owner 2026-11-19). Two rules
 * worth pinning:
 *
 *  1. A CANCELLED fair is never auto-suggested, even when its venue/brand match.
 *     A bill once auto-filled a cancelled Stadium fair because the order's
 *     hand-typed venue matched "Bukit Jalil"; the earliest-start tiebreak then
 *     picked the cancelled one.
 *  2. When the bill is one of our own sales orders, the order's OWN event leads
 *     the list (the form fills it in) and the text guesses follow, minus a
 *     repeat — so a payment's event always matches the order it pays.
 */
import { describe, expect, it } from 'vitest';
import { leadWithOrderEvent, suggestEvents, type EventSuggestion } from './event-match';
import type { EventRow } from './event-tags';

const ev = (p: Partial<EventRow> & { id: number }): EventRow => ({
  code: null, name: `Event ${p.id}`, startDate: null, endDate: null, status: 'confirmed',
  archived: false, venue: null, brand: 'ZANOTTI', organizer: null, boothNo: null, ...p,
});

const bukitJalilHint = {
  hint: { name: null, venue: 'PAVILION BUKIT JALIL', booth: null, dateFrom: null, dateTo: null },
  vendorName: null, lineText: 'ZANOTTI', billDate: '2026-09-18',
};

describe('suggestEvents — cancelled fairs', () => {
  it('never suggests a cancelled event, even on a strong venue match', () => {
    const cancelled = ev({ id: 360, venue: 'STADIUM BUKIT JALIL', status: 'cancelled', startDate: '2026-08-29', endDate: '2026-08-31' });
    const live = ev({ id: 2268, venue: 'PAVILION BUKIT JALIL', status: 'confirmed', startDate: '2026-10-09', endDate: '2026-10-11' });
    const out = suggestEvents(bukitJalilHint, [cancelled, live]);
    expect(out.map((s) => s.id)).not.toContain(360);
    expect(out.map((s) => s.id)).toContain(2268);
  });

  it('drops a cancelled event that would otherwise top the list', () => {
    const cancelled = ev({ id: 360, venue: 'STADIUM BUKIT JALIL', status: 'CANCELLED', startDate: '2026-08-29', endDate: '2026-08-31' });
    expect(suggestEvents(bukitJalilHint, [cancelled])).toEqual([]);
  });
});

describe('leadWithOrderEvent', () => {
  const guesses: EventSuggestion[] = [
    { id: 2268, score: 45, reasons: ['venue PAVILION BUKIT JALIL'], event: ev({ id: 2268 }) },
  ];

  it('puts the order event first and keeps the guesses after it', () => {
    const orderEvent = ev({ id: 2251, venue: 'SETIA CITY CONVENTION CENTRE' });
    const out = leadWithOrderEvent(orderEvent, guesses);
    expect(out[0].id).toBe(2251);
    expect(out[0].reasons).toEqual(['on the sales order']);
    expect(out.map((s) => s.id)).toEqual([2251, 2268]);
  });

  it('does not repeat the order event when a guess already names it', () => {
    const orderEvent = ev({ id: 2268 });
    const out = leadWithOrderEvent(orderEvent, guesses);
    expect(out.map((s) => s.id)).toEqual([2268]);
    expect(out[0].reasons).toEqual(['on the sales order']);
  });

  it('leaves the guesses untouched when the order has no event', () => {
    expect(leadWithOrderEvent(null, guesses)).toEqual(guesses);
  });
});
