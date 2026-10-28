import { describe, it, expect } from 'vitest';
import { eventDateLabel } from './event-date-label';

// The picker label gained the full date because the project code only carries
// the year-month; these pin the shape the dropdown shows (house yyyy/mm/dd).
describe('eventDateLabel', () => {
  it('shows a start-end range for a multi-day event', () => {
    expect(eventDateLabel('2027-02-25', '2027-02-28')).toBe('2027/02/25–2027/02/28');
  });

  it('collapses a single-day event to one date', () => {
    expect(eventDateLabel('2027-04-09', '2027-04-09')).toBe('2027/04/09');
  });

  it('uses the start when only a start is set', () => {
    expect(eventDateLabel('2027-10-13', null)).toBe('2027/10/13');
  });

  it('uses whichever bound is present when the other is missing', () => {
    expect(eventDateLabel(null, '2027-10-15')).toBe('2027/10/15');
  });

  it('ignores a time component on a datetime value', () => {
    expect(eventDateLabel('2027-02-25T00:00:00Z', '2027-02-28T00:00:00Z')).toBe('2027/02/25–2027/02/28');
  });

  it('returns empty when the project has no date', () => {
    expect(eventDateLabel(null, null)).toBe('');
    expect(eventDateLabel('', '')).toBe('');
  });
});
