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
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FairOptionsResponse } from '../vendor/scm/lib/fair-options-queries';

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

vi.mock('../vendor/scm/lib/fair-options-queries', async (orig) => ({
  ...(await orig<typeof import('../vendor/scm/lib/fair-options-queries')>()),
  useFairOptions: () => ({ data: DATA, isLoading: false, isError: false }),
}));

import { FairPicker, type FairPickValue } from './FairPicker';

function renderPicker(value: FairPickValue) {
  const onChange = vi.fn();
  render(<FairPicker value={value} soDate="2026-09-13" onChange={onChange} />);
  return { onChange };
}

const fairSelect = () => screen.getByLabelText('Fair') as HTMLSelectElement;

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

  it('opens the venue master when the order has a place but no organizer', () => {
    renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null });
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('SUNWAY PYRAMID CONVENTION CENTRE');
    expect(screen.getByText('AUSTIN INTERNATIONAL CONVENTION CENTRE')).toBeTruthy();
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
    const place = screen.getByLabelText('Place') as HTMLSelectElement;
    expect(place.value).toBe('A VENUE NOBODY MASTERS');
  });

  it('picking a place sends it with NO organizer', () => {
    const { onChange } = renderPicker({ venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: null });
    fireEvent.change(screen.getByLabelText('Place'), {
      target: { value: 'AUSTIN INTERNATIONAL CONVENTION CENTRE' },
    });
    expect(onChange).toHaveBeenCalledWith({
      venue: 'AUSTIN INTERNATIONAL CONVENTION CENTRE',
      organizer: null,
    });
  });

  it('clears both when the operator picks the blank row', () => {
    const { onChange } = renderPicker({ venue: 'MID VALLEY', organizer: 'REX' });
    fireEvent.change(fairSelect(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ venue: null, organizer: null });
  });
});
