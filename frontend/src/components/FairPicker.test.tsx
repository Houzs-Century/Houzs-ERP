/* The fair picker is where a salesperson says which exhibition a sale belongs
 * to, so these cases are the owner's 2026-09-13 rules made executable:
 *
 *   - a row is a PLACE, an ORGANIZER and the event's DATES, and all three travel
 *     on the pick (owner 2026-09-19 — the dates are what name the occurrence,
 *     and the server matches the event on them);
 *   - the list is the last FOUR WEEKS ending at the order date, so a fair that
 *     has already closed is pickable and a fair that has not started is not;
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
    { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [340, 341, 342, 2250] },
    { key: 'the commune kulai|inhome|2026-09-11|2026-09-13', venue: 'THE COMMUNE KULAI', organizer: 'INHOME', startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [2258] },
  ],
  earlier: [
    { key: 'sunway pyramid convention centre|bighome|2026-09-04|2026-09-06', venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: 'BIGHOME', startDate: '2026-09-04', endDate: '2026-09-06', projectIds: [361] },
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
  earlier: [
    { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [340, 341, 342, 2250] },
  ],
  venues: [
    { id: '10', name: 'AUSTIN INTERNATIONAL CONVENTION CENTRE' },
    { id: '1', name: 'MID VALLEY' },
    { id: '28', name: 'SUNWAY PYRAMID CONVENTION CENTRE' },
  ],
};

/* Three DIFFERENT fairs at ONE venue inside one four-week window, from
   production: MID VALLEY, projects 363 (BIGHOME, 10-02), 2260 (HOMELOVE, 09-17)
   and 313/314/316 (MLE, 09-25 — three brand booths that collapse to one row).
   This is the shape a venue-only label erases: three rows that read identically
   unless the organizer AND the dates are on them. Read on 2026-09-16 with
   `select venue, organizer, start_date from public.projects where company_id = 1`;
   the HOMELOVE and MLE dates are moved back into the window from their real
   10-15 / 10-23, because an order dated 2026-10-08 is never offered a fair that
   has not happened yet. Ordered as buildFairOptions returns them for that date:
   nothing is running, so all three sit in `earlier`, NEWEST FIRST. */
const DATA_2026_10_MID_VALLEY: FairOptionsResponse = {
  date: '2026-10-08',
  running: [],
  earlier: [
    { key: 'mid valley|bighome|2026-10-02|2026-10-04', venue: 'MID VALLEY', organizer: 'BIGHOME', startDate: '2026-10-02', endDate: '2026-10-04', projectIds: [363] },
    { key: 'mid valley|mle|2026-09-25|2026-09-27', venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-09-25', endDate: '2026-09-27', projectIds: [313, 314, 316] },
    { key: 'mid valley|homelove|2026-09-17|2026-09-20', venue: 'MID VALLEY', organizer: 'HOMELOVE', startDate: '2026-09-17', endDate: '2026-09-20', projectIds: [2260] },
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
  it('labels every row VENUE — ORGANIZER (DATES) (owner 2026-09-16, 2026-09-19)', () => {
    /* The organizer was hidden from these labels on 2026-09-15 (#3999) and the
       owner reversed it the next morning: 「我是写 venue，然后旁边还有 organizer
       的名字的，它不是单纯就是 venue only」. The DATES joined it on 2026-09-19,
       reversing his earlier "no dates" ruling — the list became four weeks of
       closed fairs, where picking a row means saying which occurrence. */
    renderPicker({ venue: null, organizer: null, startDate: null, endDate: null });
    expect(screen.getByText('MID VALLEY — REX (11/09 - 13/09)')).toBeTruthy();
    expect(screen.getByText('THE COMMUNE KULAI — INHOME (11/09 - 13/09)')).toBeTruthy();
    expect(
      screen.getByText('SUNWAY PYRAMID CONVENTION CENTRE — BIGHOME (04/09 - 06/09)'),
    ).toBeTruthy();
  });

  it('keeps two fairs at ONE venue apart — the case venue-only labels erased', () => {
    /* Production at MID VALLEY: three fairs, three organizers (project 363
       BIGHOME, 2260 HOMELOVE, 313/314/316 MLE), all inside one four-week window.
       Nothing but the organizer and the dates tells them apart, which
       the organizer repeat, so the organizer is the ONLY thing telling them
       apart. Labelled by venue alone they were three identical "MID VALLEY" rows
       and the sale landed in whichever fair's P&L the rep happened to hit. */
    fixture.data = DATA_2026_10_MID_VALLEY;
    renderPicker({ venue: null, organizer: null, startDate: null, endDate: null }, '2026-10-08');
    const fairs = fairOptionLabels().filter((l) => l.startsWith('MID VALLEY'));
    expect(fairs).toEqual([
      'MID VALLEY — BIGHOME (02/10 - 04/10)',
      'MID VALLEY — MLE (25/09 - 27/09)',
      'MID VALLEY — HOMELOVE (17/09 - 20/09)',
    ]);
    expect(new Set(fairs).size).toBe(3);
  });

  it('reads a SOLO roadshow as SOLO; an exhibition keeps its organizer (owner 2026-09-18)', () => {
    fixture.data = {
      ...DATA,
      running: [
        { key: 'ioi mall putrajaya|mall mgt|2026-09-11|2026-09-13', venue: 'IOI MALL PUTRAJAYA', organizer: 'MALL MGT', solo: true, startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [1] },
        { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', solo: false, startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [340] },
      ],
      earlier: [],
    };
    const { onChange } = renderPicker({ venue: null, organizer: null, startDate: null, endDate: null });
    const labels = fairOptionLabels();
    expect(labels).toContain('IOI MALL PUTRAJAYA — SOLO (11/09 - 13/09)');
    expect(labels).toContain('MID VALLEY — REX (11/09 - 13/09)');
    expect(labels.some((l) => l.includes('MALL MGT'))).toBe(false);
    /* Only the wording changed: the pick still carries the real organizer, which
       is what the server resolves the project from. */
    fireEvent.change(fairSelect(), { target: { value: 'fair:ioi mall putrajaya|mall mgt|2026-09-11|2026-09-13' } });
    expect(onChange).toHaveBeenCalledWith({
      venue: 'IOI MALL PUTRAJAYA', organizer: 'MALL MGT',
      startDate: '2026-09-11', endDate: '2026-09-13',
    });
  });

  it('sends the venue AND the organizer when a fair is picked', () => {
    const { onChange } = renderPicker({ venue: null, organizer: null, startDate: null, endDate: null });
    fireEvent.change(fairSelect(), { target: { value: 'fair:mid valley|rex|2026-09-11|2026-09-13' } });
    expect(onChange).toHaveBeenCalledWith({ venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13' });
  });

  it('shows the saved fair as selected when the order already has one', () => {
    renderPicker({ venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13' });
    expect(fairSelect().value).toBe('fair:mid valley|rex|2026-09-11|2026-09-13');
    /* No second control while a real fair is picked. */
    expect(screen.queryByLabelText('Place')).toBeNull();
  });
});

describe('FairPicker — Others is a PICK, never a text box', () => {
  it('offers no text input anywhere', () => {
    const { container } = render(
      <FairPicker value={{ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null, startDate: null, endDate: null }} soDate="2026-09-13" onChange={vi.fn()} />,
    );
    expect(container.querySelectorAll('input').length).toBe(0);
  });

  it('opens the venue master when the operator picks Others, keeping the place on the order', () => {
    /* Until 2026-09-15 this list opened by itself for any place with no organizer —
       which is every saved order — and the Fair field read "Others". The owner
       ruled that state wrong: the list is something the operator OPENS. */
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null, startDate: null, endDate: null });
    expect(screen.queryByLabelText('Place')).toBeNull();
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(onChange).toHaveBeenCalledWith({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null, startDate: null, endDate: null });
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('SUNWAY PYRAMID CONVENTION CENTRE');
    expect(screen.getByText('AUSTIN INTERNATIONAL CONVENTION CENTRE')).toBeTruthy();
    /* The Fair field goes on naming the place while the list is open. */
    expect(shownText(fairSelect())).toBe('SUNWAY PYRAMID CONVENTION CENTRE');
  });

  it('KEEPS the place already on the order when switching to Others', () => {
    /* "The list did not have my fair" is not "clear the venue". Clearing it here
       would quietly drop the only thing the nightly reconcile has to work with. */
    const { onChange } = renderPicker({ venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13' });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    /* The PERIOD goes with the organizer: Others means no event was chosen, and
       a stale period would tell the server to match an occurrence the operator
       has just rejected. */
    expect(onChange).toHaveBeenCalledWith({ venue: 'MID VALLEY', organizer: null, startDate: null, endDate: null });
  });

  it('still shows a venue the master no longer lists', () => {
    /* An order written at a venue since renamed or deactivated must not lose its
       place the moment someone opens the form. */
    renderPicker({ venue: 'A VENUE NOBODY MASTERS', organizer: null, startDate: null, endDate: null });
    expect(shownText(fairSelect())).toBe('A VENUE NOBODY MASTERS');
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('A VENUE NOBODY MASTERS');
  });

  it('picking a place sends it with NO organizer', () => {
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null, startDate: null, endDate: null });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    fireEvent.change(screen.getByLabelText('Place'), {
      target: { value: 'AUSTIN INTERNATIONAL CONVENTION CENTRE' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      venue: 'AUSTIN INTERNATIONAL CONVENTION CENTRE',
      organizer: null,
      startDate: null,
      endDate: null,
    });
  });

  it('clears both when the operator picks the blank row', () => {
    const { onChange } = renderPicker({ venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13' });
    fireEvent.change(fairSelect(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ venue: null, organizer: null, startDate: null, endDate: null });
  });

  it('a blank form can reach the venue master through Others', () => {
    /* Picking Others with no place yet sends {null, null} — the value the form
       already holds — so nothing re-rendered into the place list and the select
       fell back to "—". The one way to a place missing from the fair list was shut
       on exactly the forms with no default venue. */
    const { onChange } = renderPicker({ venue: null, organizer: null, startDate: null, endDate: null });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(onChange).toHaveBeenCalledWith({ venue: null, organizer: null, startDate: null, endDate: null });
    expect(fairSelect().value).toBe('__others__');
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('');
    expect(screen.getByText('AUSTIN INTERNATIONAL CONVENTION CENTRE')).toBeTruthy();
  });

  it('picking a fair closes the place list again', () => {
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null, startDate: null, endDate: null });
    fireEvent.change(fairSelect(), { target: { value: '__others__' } });
    expect(screen.getByLabelText('Place')).toBeTruthy();
    fireEvent.change(fairSelect(), { target: { value: 'fair:mid valley|rex|2026-09-11|2026-09-13' } });
    /* THE WHOLE ROW TRAVELS. The period is what lets the server match the exact
       occurrence instead of re-deriving one from the order date — dropping it
       here is what made an order written after its fair closed impossible to
       attribute by any path in the system. */
    expect(onChange).toHaveBeenLastCalledWith({
      venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13',
    });
    expect(screen.queryByLabelText('Place')).toBeNull();
  });
});

describe('FairPicker — a place already on the order IS the value (owner 2026-09-15)', () => {
  it('HC-SO-2609-071 in edit mode reads MID VALLEY, not "Others — pick a place instead"', () => {
    fixture.data = DATA_2026_09_14;
    /* Exactly what SalesOrderDetail passes: the stored venue, and organizer null
       because an order does not store one. */
    renderPicker({ venue: 'MID VALLEY', organizer: null, startDate: null, endDate: null }, '2026-09-14');
    expect(fairSelect().value).not.toBe('__others__');
    expect(shownText(fairSelect())).toBe('MID VALLEY');
    expect(screen.queryByLabelText('Place')).toBeNull();
  });

  it('does not light up a fair the order is not linked to', () => {
    /* The only MID VALLEY row ended the day before this order was written. Picking
       it from the venue alone would attribute the sale to a fair that was not
       running — the error the fair link exists to prevent. */
    fixture.data = DATA_2026_09_14;
    renderPicker({ venue: 'MID VALLEY', organizer: null, startDate: null, endDate: null }, '2026-09-14');
    expect(fairSelect().value).not.toBe('fair:mid valley|rex|2026-09-11|2026-09-13');
  });

  it('files a fair that already ended under "Recently closed", and can still pick it', () => {
    /* The closed group is the rest of the four-week window — fairs that are over,
       never ones still to come. For 071 its only row ended on the 13th, and the
       whole point of the 2026-09-19 change is that such a row is a legitimate
       answer rather than an unattributable order. */
    fixture.data = DATA_2026_09_14;
    const onChange = vi.fn();
    const { container } = render(
      <FairPicker
        value={{ venue: null, organizer: null, startDate: null, endDate: null }}
        soDate="2026-09-14"
        onChange={onChange}
      />,
    );
    const labels = [...container.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    expect(labels).not.toContain('Later this month');
    expect(labels).not.toContain('Other fairs this month');
    expect(labels).toContain('Recently closed (last 4 weeks)');

    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'fair:mid valley|rex|2026-09-11|2026-09-13' } });
    expect(onChange).toHaveBeenLastCalledWith({
      venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13',
    });
  });

  it('shows the DATES on every row, so the operator can say which occurrence', () => {
    fixture.data = DATA_2026_09_14;
    const { container } = render(
      <FairPicker
        value={{ venue: null, organizer: null, startDate: null, endDate: null }}
        soDate="2026-09-14"
        onChange={vi.fn()}
      />,
    );
    const texts = [...container.querySelectorAll('optgroup option')].map((o) => o.textContent);
    expect(texts).toContain('MID VALLEY — REX (11/09 - 13/09)');
  });
});
