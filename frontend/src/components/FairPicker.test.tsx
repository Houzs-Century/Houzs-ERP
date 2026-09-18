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

/* Three DIFFERENT fairs at ONE venue in one month, from production: MID VALLEY in
   October 2026, projects 363 (BIGHOME, 10-02), 2260 (HOMELOVE, 10-15) and
   313/314/316 (MLE, 10-23 — three brand booths that collapse to one row). This is
   the shape a venue-only label erases: `showDates` is false on all three, because
   the server sets it only when the venue AND the organizer repeat, so the
   organizer is the only thing that tells them apart. Read on 2026-09-16 with
   `select venue, organizer, start_date from public.projects where company_id = 1`.
   Ordered as buildFairOptions returns them for an order dated 2026-10-08: nothing
   is running that day, so all three sit in `month`, sorted by start date. */
const DATA_2026_10_MID_VALLEY: FairOptionsResponse = {
  date: '2026-10-08',
  running: [],
  month: [
    { key: 'mid valley|bighome|2026-10-02|2026-10-04', venue: 'MID VALLEY', organizer: 'BIGHOME', startDate: '2026-10-02', endDate: '2026-10-04', showDates: false, projectIds: [363] },
    { key: 'mid valley|homelove|2026-10-15|2026-10-18', venue: 'MID VALLEY', organizer: 'HOMELOVE', startDate: '2026-10-15', endDate: '2026-10-18', showDates: false, projectIds: [2260] },
    { key: 'mid valley|mle|2026-10-23|2026-10-25', venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-10-23', endDate: '2026-10-25', showDates: false, projectIds: [313, 314, 316] },
  ],
  venues: [{ id: '1', name: 'MID VALLEY' }],
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
const fairOptionLabels = () => [...fairSelect().options].map((o) => o.textContent);

describe('FairPicker — a row is a place plus an organizer', () => {
  it('labels every row VENUE — ORGANIZER, with no dates (owner 2026-09-16)', () => {
    /* The organizer was hidden from these labels on 2026-09-15 (#3999) and the
       owner reversed it the next morning: 「我是写 venue，然后旁边还有 organizer
       的名字的，它不是单纯就是 venue only」. */
    renderPicker({ venue: null, organizer: null });
    expect(screen.getByText('MID VALLEY — REX')).toBeTruthy();
    expect(screen.getByText('THE COMMUNE KULAI — INHOME')).toBeTruthy();
    /* The one exception: the server flagged this row because another row in the
       same month would read identically. */
    expect(screen.getByText('MVEC SOUTHKEY — REX (2026-09-18 ~ 2026-09-20)')).toBeTruthy();
  });

  it('keeps two fairs at ONE venue apart — the case venue-only labels erased', () => {
    /* Production, 2026-10 at MID VALLEY: three fairs, three organizers (project
       363 BIGHOME 10-02, 2260 HOMELOVE 10-15, 313/314/316 MLE 10-23). `showDates`
       is false on all three because the server only sets it when the venue AND
       the organizer repeat, so the organizer is the ONLY thing telling them
       apart. Labelled by venue alone they were three identical "MID VALLEY" rows
       and the sale landed in whichever fair's P&L the rep happened to hit. */
    fixture.data = DATA_2026_10_MID_VALLEY;
    renderPicker({ venue: null, organizer: null }, '2026-10-08');
    const fairs = fairOptionLabels().filter((l) => l.startsWith('MID VALLEY'));
    expect(fairs).toEqual([
      'MID VALLEY — BIGHOME',
      'MID VALLEY — HOMELOVE',
      'MID VALLEY — MLE',
    ]);
    expect(new Set(fairs).size).toBe(3);
  });

  it('reads a SOLO roadshow as SOLO; an exhibition keeps its organizer (owner 2026-09-18)', () => {
    fixture.data = {
      ...DATA,
      running: [
        { key: 'ioi mall putrajaya|mall mgt|2026-09-11|2026-09-13', venue: 'IOI MALL PUTRAJAYA', organizer: 'MALL MGT', solo: true, startDate: '2026-09-11', endDate: '2026-09-13', showDates: false, projectIds: [1] },
        { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', solo: false, startDate: '2026-09-11', endDate: '2026-09-13', showDates: false, projectIds: [340] },
      ],
      month: [],
    };
    const { onChange } = renderPicker({ venue: null, organizer: null });
    const labels = fairOptionLabels();
    expect(labels).toContain('IOI MALL PUTRAJAYA — SOLO');
    expect(labels).toContain('MID VALLEY — REX');
    expect(labels.some((l) => (l ?? '').includes('MALL MGT'))).toBe(false);
    /* Only the wording changed: the pick still carries the real organizer, which
       is what the server resolves the project from. */
    fireEvent.change(fairSelect(), { target: { value: 'fair:ioi mall putrajaya|mall mgt|2026-09-11|2026-09-13' } });
    expect(onChange).toHaveBeenCalledWith({ venue: 'IOI MALL PUTRAJAYA', organizer: 'MALL MGT' });
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
