/* The fair picker is where a salesperson says which exhibition a sale belongs
 * to, so these cases are the owner's 2026-09-13 rules made executable:
 *
 *   - a row is a PLACE plus an ORGANIZER, and carries no date unless the server
 *     says two rows would otherwise read identically;
 *   - NOBODY TYPES — "Others" is a second PICK over the venue master;
 *   - switching to Others keeps the place already on the order rather than
 *     clearing it;
 *   - a venue the master no longer lists still shows, instead of the operator's
 *     saved answer silently disappearing.
 *
 * The fixture is real: MID VALLEY / REX and THE COMMUNE KULAI / INHOME were the
 * two fairs running for Houzs Century on 2026-09-13.
 *
 * Owner 2026-09-15, looking at HC-SO-2609-071 in edit mode: 「应该是venue的」.
 * A place already on the order is the field's VALUE. It used to render as the
 * "Others — pick a place instead" sentinel with the place pushed into a second
 * box, on every order that carries a venue — see docs/bugs/0936-*.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FairOptionsResponse } from '../vendor/scm/lib/fair-options-queries';

/* Swappable per test: most cases use the 2026-09-13 list; the edit-mode cases use
   the list production served for HC-SO-2609-071's own date. */
const fixture = vi.hoisted(() => ({ data: null as FairOptionsResponse | null }));

const DATA: FairOptionsResponse = {
  date: '2026-09-13',
  running: [
    { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', showDates: false, projectIds: [340, 341, 342, 2250] },
    { key: 'the commune kulai|inhome|2026-09-11|2026-09-13', venue: 'THE COMMUNE KULAI', organizer: 'INHOME', startDate: '2026-09-11', endDate: '2026-09-13', showDates: false, projectIds: [2258] },
  ],
  month: [
    { key: 'mvec southkey|rex|2026-09-18|2026-09-20', venue: 'MVEC SOUTHKEY', organizer: 'REX', startDate: '2026-09-18', endDate: '2026-09-20', showDates: true, projectIds: [346] },
  ],
  venues: [
    { id: '11', name: 'AUSTIN INTERNATIONAL CONVENTION CENTRE' },
    { id: '12', name: 'SUNWAY PYRAMID CONVENTION CENTRE' },
  ],
};

/* The list production served for Houzs Century on 2026-09-14, HC-SO-2609-071's
   own date: production's project rows run through the server's buildFairOptions
   on 2026-09-15, trimmed to the one row at MID VALLEY (the other 11 are at other
   venues). NOTHING was running that day — the MID VALLEY row is the REX fair that
   ended on the 13th. Venue ids are the live project_venues ids. */
const DATA_2026_09_14: FairOptionsResponse = {
  date: '2026-09-14',
  running: [],
  month: [
    { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', showDates: false, projectIds: [340, 341, 342, 2250] },
  ],
  venues: [
    { id: '10', name: 'AUSTIN INTERNATIONAL CONVENTION CENTRE' },
    { id: '1', name: 'MID VALLEY' },
    { id: '28', name: 'SUNWAY PYRAMID CONVENTION CENTRE' },
  ],
};

vi.mock('../vendor/scm/lib/fair-options-queries', async (orig) => ({
  ...(await orig<typeof import('../vendor/scm/lib/fair-options-queries')>()),
  useFairOptions: () => ({ data: fixture.data ?? DATA, isLoading: false, isError: false }),
}));

import { FairPicker, type FairPickValue } from './FairPicker';

afterEach(() => { fixture.data = null; });

function renderPicker(value: FairPickValue, soDate = '2026-09-13') {
  const onChange = vi.fn();
  render(<FairPicker value={value} soDate={soDate} onChange={onChange} />);
  return { onChange };
}

const fairSelect = () => screen.getByLabelText('Fair') as HTMLSelectElement;
const shownText = (s: HTMLSelectElement) => s.selectedOptions.item(0)?.textContent ?? '';

describe('FairPicker — a row is a place plus an organizer', () => {
  it('labels rows with no dates, and groups running-now above the rest', () => {
    renderPicker({ venue: null, organizer: null });
    expect(screen.getByText('MID VALLEY — REX')).toBeTruthy();
    expect(screen.getByText('THE COMMUNE KULAI — INHOME')).toBeTruthy();
    /* The one exception: the server flagged this row because another row in the
       same month would read identically. */
    expect(screen.getByText('MVEC SOUTHKEY — REX (2026-09-18 ~ 2026-09-20)')).toBeTruthy();
  });

  it('sends the venue AND the organizer when a fair is picked', () => {
    const { onChange } = renderPicker({ venue: null, organizer: null });
    fireEvent.change(fairSelect(), { target: { value: 'fair:mid valley|rex|2026-09-11|2026-09-13' } });
    expect(onChange).toHaveBeenCalledWith({ venue: 'MID VALLEY', organizer: 'REX' });
  });

  it('shows the saved fair as selected when the order already has one', () => {
    renderPicker({ venue: 'MID VALLEY', organizer: 'REX' });
    expect(fairSelect().value).toBe('fair:mid valley|rex|2026-09-11|2026-09-13');
    /* No second control while a real fair is picked. */
    expect(screen.queryByLabelText('Place')).toBeNull();
  });
});

describe('FairPicker — Others is a PICK, never a text box', () => {
  it('offers no text input anywhere', () => {
    const { container } = render(
      <FairPicker value={{ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null }} soDate="2026-09-13" onChange={vi.fn()} />,
    );
    expect(container.querySelectorAll('input').length).toBe(0);
  });

  it('opens the venue master when the operator picks Others, keeping the place on the order', () => {
    /* Until 2026-09-15 this list opened by itself for any place with no organizer —
       which is every saved order — and the Fair field read "Others". The owner
       ruled that state wrong: the list is something the operator OPENS. */
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null });
    expect(screen.queryByLabelText('Place')).toBeNull();
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(onChange).toHaveBeenCalledWith({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null });
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('SUNWAY PYRAMID CONVENTION CENTRE');
    expect(screen.getByText('AUSTIN INTERNATIONAL CONVENTION CENTRE')).toBeTruthy();
    /* The Fair field goes on naming the place while the list is open. */
    expect(shownText(fairSelect())).toBe('SUNWAY PYRAMID CONVENTION CENTRE');
  });

  it('KEEPS the place already on the order when switching to Others', () => {
    /* "The list did not have my fair" is not "clear the venue". Clearing it here
       would quietly drop the only thing the nightly reconcile has to work with. */
    const { onChange } = renderPicker({ venue: 'MID VALLEY', organizer: 'REX' });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(onChange).toHaveBeenCalledWith({ venue: 'MID VALLEY', organizer: null });
  });

  it('still shows a venue the master no longer lists', () => {
    /* An order written at a venue since renamed or deactivated must not lose its
       place the moment someone opens the form. */
    renderPicker({ venue: 'A VENUE NOBODY MASTERS', organizer: null });
    expect(shownText(fairSelect())).toBe('A VENUE NOBODY MASTERS');
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('A VENUE NOBODY MASTERS');
  });

  it('picking a place sends it with NO organizer', () => {
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    fireEvent.change(screen.getByLabelText('Place'), {
      target: { value: 'AUSTIN INTERNATIONAL CONVENTION CENTRE' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      venue: 'AUSTIN INTERNATIONAL CONVENTION CENTRE',
      organizer: null,
    });
  });

  it('clears both when the operator picks the blank row', () => {
    const { onChange } = renderPicker({ venue: 'MID VALLEY', organizer: 'REX' });
    fireEvent.change(fairSelect(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ venue: null, organizer: null });
  });

  it('a blank form can reach the venue master through Others', () => {
    /* Picking Others with no place yet sends {null, null} — the value the form
       already holds — so nothing re-rendered into the place list and the select
       fell back to "—". The one way to a place missing from the fair list was shut
       on exactly the forms with no default venue. */
    const { onChange } = renderPicker({ venue: null, organizer: null });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(onChange).toHaveBeenCalledWith({ venue: null, organizer: null });
    expect(fairSelect().value).toBe('__others__');
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('');
    expect(screen.getByText('AUSTIN INTERNATIONAL CONVENTION CENTRE')).toBeTruthy();
  });

  it('picking a fair closes the place list again', () => {
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(screen.getByLabelText('Place')).toBeTruthy();
    fireEvent.change(fairSelect(), { target: { value: 'fair:mid valley|rex|2026-09-11|2026-09-13' } });
    expect(onChange).toHaveBeenLastCalledWith({ venue: 'MID VALLEY', organizer: 'REX' });
    expect(screen.queryByLabelText('Place')).toBeNull();
  });
});

describe('FairPicker — a place already on the order IS the value (owner 2026-09-15)', () => {
  it('HC-SO-2609-071 in edit mode reads MID VALLEY, not "Others — pick a place instead"', () => {
    fixture.data = DATA_2026_09_14;
    /* Exactly what SalesOrderDetail passes: the stored venue, and organizer null
       because an order does not store one. */
    renderPicker({ venue: 'MID VALLEY', organizer: null }, '2026-09-14');
    expect(fairSelect().value).not.toBe('__others__');
    expect(shownText(fairSelect())).toBe('MID VALLEY');
    expect(screen.queryByLabelText('Place')).toBeNull();
  });

  it('does not light up a fair the order is not linked to', () => {
    /* The only MID VALLEY row ended the day before this order was written. Picking
       it from the venue alone would attribute the sale to a fair that was not
       running — the error the fair link exists to prevent. */
    fixture.data = DATA_2026_09_14;
    renderPicker({ venue: 'MID VALLEY', organizer: null }, '2026-09-14');
    expect(fairSelect().value).not.toBe('fair:mid valley|rex|2026-09-11|2026-09-13');
  });

  it('files a fair that already ended under this month, not "later this month"', () => {
    /* The month group is everything in the calendar month that is not running on
       the order date — before it as well as after (fair-options.ts). For 071 its
       only row ended on the 13th. */
    fixture.data = DATA_2026_09_14;
    const { container } = render(
      <FairPicker value={{ venue: null, organizer: null }} soDate="2026-09-14" onChange={vi.fn()} />,
    );
    const labels = [...container.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    expect(labels).not.toContain('Later this month');
    expect(labels).toContain('Other fairs this month');
  });
});
