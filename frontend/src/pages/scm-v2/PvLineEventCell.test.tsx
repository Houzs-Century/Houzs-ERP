/* A voucher line's event on the detail table (owner 2026-09-30, 5a): the label
   reads from the labels map; Finance's pencil opens the picker and a pick sends
   the change (the server moves the line and its journal leg together); picking
   the same event sends nothing; without the right there is no pencil. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const EVENT_OPTIONS = [
  { id: 336, code: 'E-336', name: 'Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE', startDate: '2026-09-04', endDate: '2026-09-06', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'HOMELOVE', boothNo: null },
  { id: 348, code: 'E-348', name: 'Pulau Pinang [AKEMI] MLE @ PWCC', startDate: '2026-09-25', endDate: '2026-09-27', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: 'MLE', boothNo: 'F1' },
];
const retagMutate = vi.fn();
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => ({ data: EVENT_OPTIONS, isLoading: false }),
  useEventLabels: () => ({ data: undefined }),
  useRetagPvLine: () => ({ mutate: retagMutate, isPending: false }),
}));

import { PvLineEventCell } from './PvLineEventCell';

const labels = new Map(EVENT_OPTIONS.map((e) => [e.id, e]));

describe('PvLineEventCell', () => {
  test('reads the label; the pencil opens the picker and a new pick is sent for this line', () => {
    retagMutate.mockClear();
    render(<PvLineEventCell lineId="line-1" projectId={336} labels={labels} around="2026-09-02" canChange />);
    expect(screen.getByText('Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE · 09/04 - 09/06')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Change the event'));
    fireEvent.focus(screen.getByLabelText("Change this line's event"));
    fireEvent.mouseDown(screen.getByText(/MLE @ PWCC/));
    expect(retagMutate).toHaveBeenCalledTimes(1);
    expect(retagMutate.mock.calls[0]![0]).toEqual({ lineId: 'line-1', projectId: 348 });
  });

  test('picking the event it already has sends nothing; clearing sends null', () => {
    retagMutate.mockClear();
    render(<PvLineEventCell lineId="line-1" projectId={336} labels={labels} around="2026-09-02" canChange />);
    fireEvent.click(screen.getByLabelText('Change the event'));
    fireEvent.focus(screen.getByLabelText("Change this line's event"));
    fireEvent.mouseDown(screen.getByText(/HOMELOVE @ SETIA SPICE/, { selector: '[role="option"], li, div' }));
    expect(retagMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Change the event'));
    fireEvent.focus(screen.getByLabelText("Change this line's event"));
    fireEvent.mouseDown(screen.getByText('— No event —'));
    expect(retagMutate.mock.calls[0]![0]).toEqual({ lineId: 'line-1', projectId: null });
  });

  test('without the right there is no pencil; no event reads as a dash', () => {
    render(<PvLineEventCell lineId="line-2" projectId={null} labels={labels} around={null} canChange={false} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByLabelText('Change the event')).toBeNull();
  });
});
