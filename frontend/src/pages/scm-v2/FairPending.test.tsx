/* The screen that settles a fair link a person has to decide.
 *
 * What these cases pin is mostly what the screen REFUSES to do: it never offers
 * a fair at a place the order does not record, it never offers one that was not
 * running on the order's own date, and it keeps the three reasons apart instead
 * of showing one undifferentiated pile — "waiting for the fair" needs nobody,
 * "pick one" needs a person, and they must not look the same.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  FairPendingRow,
  FairOptionsResponse,
} from '../../vendor/scm/lib/fair-options-queries';

const ROWS: FairPendingRow[] = [
  { doc_no: 'HC-SO-2609-064', so_date: '2026-09-13', venue: 'MID VALLEY', branding: null, project_id: null, fair_match: 'AMBIGUOUS', status: 'CONFIRMED', local_total_sen: 355860, salesperson_id: 's1' },
  { doc_no: 'HC-SO-2609-065', so_date: '2026-09-13', venue: 'SUNWAY PYRAMID CONVENTION CENTRE', branding: null, project_id: null, fair_match: 'PENDING', status: 'CONFIRMED', local_total_sen: 658800, salesperson_id: 's2' },
  { doc_no: 'HC-SO-2609-063', so_date: '2026-09-12', venue: 'MID VALLEY', branding: 'DUNLOPILLO', project_id: null, fair_match: 'UNMATCHED', status: 'CONFIRMED', local_total_sen: 544000, salesperson_id: 's3' },
  /* Listed since 2026-10-19 (「没有 assign 到 fair 的就列出来」): an explicit No
     fair, and an order keyed before the picker that carries no verdict at all. */
  { doc_no: 'HC-SO-2609-222', so_date: '2026-09-27', venue: 'SUNWAY CARNIVAL', branding: 'DUNLOPILLO', project_id: null, fair_match: 'NO_FAIR', status: 'CONFIRMED', local_total_sen: 500000, salesperson_id: 's4' },
  { doc_no: 'HC-SO-2609-009', so_date: '2026-09-09', venue: 'PAVILION BUKIT JALIL', branding: 'BEDFRAME', project_id: null, fair_match: null, status: 'CONFIRMED', local_total_sen: 180000, salesperson_id: 's5' },
];

const OPTIONS: FairOptionsResponse = {
  date: '2026-09-13',
  running: [
    { key: 'mid valley|rex|2026-09-11|2026-09-13', venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-09-11', endDate: '2026-09-13', projectIds: [340, 341] },
  ],
  earlier: [],
  venues: [],
};

const assign = vi.fn();

vi.mock('../../vendor/scm/lib/fair-options-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/fair-options-queries')>()),
  useFairPending: () => ({ data: ROWS, isLoading: false, isError: false }),
  useFairOptions: () => ({ data: OPTIONS, isLoading: false, isError: false }),
  useAssignFair: () => ({ mutate: assign, isPending: false }),
}));

import { FairPending } from './FairPending';

describe('FairPending', () => {
  it('keeps the reasons apart — they are different jobs', () => {
    render(<FairPending />);
    expect(screen.getByText('Pick one (1)')).toBeTruthy();
    expect(screen.getByText('Brand has no booth (1)')).toBeTruthy();
    expect(screen.getByText('Waiting for the fair (1)')).toBeTruthy();
    expect(screen.getByText('Marked No fair (1)')).toBeTruthy();
    expect(screen.getByText('Keyed before the fair picker (1)')).toBeTruthy();
    expect(screen.getByText('5 orders not yet attributed to a fair.')).toBeTruthy();
  });

  it('never files an order with no verdict as waiting for the fair', () => {
    /* A NULL verdict used to fall into "Waiting for the fair", which says nobody
       needs to act — wrong for an order nothing ever tried to link. */
    render(<FairPending />);
    const waiting = screen.getByText('Waiting for the fair (1)').closest('section') as HTMLElement;
    expect(waiting.textContent).not.toContain('HC-SO-2609-009');
    const before = screen.getByText('Keyed before the fair picker (1)').closest('section') as HTMLElement;
    expect(before.textContent).toContain('HC-SO-2609-009');
  });

  it('offers each brand booth at the order’s own place', () => {
    render(<FairPending />);
    const sel = screen.getByLabelText('Fair for HC-SO-2609-064') as HTMLSelectElement;
    const labels = [...sel.options].map((o) => o.text);
    expect(labels).toContain('MID VALLEY — REX (09/11 - 09/13) #340');
    expect(labels).toContain('MID VALLEY — REX (09/11 - 09/13) #341');
  });

  it('offers NOTHING for an order whose place has no fair that day', () => {
    /* The Sunway order is the real 2026-09-13 case: a venue whose last fair
       ended on the 6th. Offering the MID VALLEY row here would be inventing an
       attribution, so the control is disabled and says why. */
    render(<FairPending />);
    const sel = screen.getByLabelText('Fair for HC-SO-2609-065') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    expect([...sel.options].map((o) => o.text)).toEqual(['No fair at that place on that date']);
  });

  it('links only the picked project, and only once a pick exists', () => {
    render(<FairPending />);
    const buttons = screen.getAllByRole('button', { name: 'Link' });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fair for HC-SO-2609-064'), { target: { value: '341' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    expect(assign).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-064', projectId: 341 });
  });
});
