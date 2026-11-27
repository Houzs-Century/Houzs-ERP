/* Rescheduling a service-case leg records an amend reason (owner 2026-11-16): the
   drawer offers the preset reasons and saves the reason alongside the date. The
   reason writes through the per-leg /fields path; the date through /schedule. */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const schedMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
const fieldsMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
const notify = vi.fn();

vi.mock('../lib/delivery-planning-queries', async (importActual) => {
  const actual = await importActual<typeof import('../lib/delivery-planning-queries')>();
  return {
    ...actual,
    useScheduleDelivery: () => ({ mutate: schedMutate, isPending: false }),
    useUpdateDeliveryFields: () => ({ mutate: fieldsMutate, isPending: false }),
  };
});
vi.mock('./NotifyDialog', () => ({ useNotify: () => notify }));
vi.mock('../lib/delivery-amend-reasons-queries', async () => {
  const actual = await import('../lib/delivery-planning-queries');
  return { useAmendReasonOptions: () => actual.AMEND_REASONS };
});

import { SetJobDateDrawer } from './SetJobDateDrawer';
import { AMEND_REASONS, type PlanningOrder } from '../lib/delivery-planning-queries';

const leg = (o: Partial<PlanningOrder> = {}): PlanningOrder =>
  ({
    row_type: 'assr', assr_id: 123, job_kind: 'delivery', ref: 'ASSR/2611-019',
    debtor_name: 'Tan', customer_delivery_date: '2026-11-17', amended_delivery_date: '2026-11-17',
    amend_reason: null, ...o,
  }) as unknown as PlanningOrder;

const PRESET = AMEND_REASONS[0];

beforeEach(() => { schedMutate.mockClear(); fieldsMutate.mockClear(); notify.mockClear(); });

describe('SetJobDateDrawer — amend reason', () => {
  test('offers the preset reasons in the picker', () => {
    render(<SetJobDateDrawer order={leg()} onClose={vi.fn()} />);
    expect(screen.getByRole('option', { name: PRESET })).toBeTruthy();
  });

  test('a reason-only change writes the per-leg reason and closes, without touching the date', () => {
    const onClose = vi.fn();
    render(<SetJobDateDrawer order={leg()} onClose={onClose} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: PRESET } });
    fireEvent.click(screen.getByText('Save'));
    expect(fieldsMutate).toHaveBeenCalledTimes(1);
    expect(fieldsMutate.mock.calls[0]![0]).toMatchObject({ type: 'assr', id: '123', jobKind: 'delivery', amendReason: PRESET });
    expect(schedMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test('a date-only change writes the schedule date, not the reason', () => {
    render(<SetJobDateDrawer order={leg({ amended_delivery_date: null, customer_delivery_date: '2026-11-20' })} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Save'));
    expect(schedMutate).toHaveBeenCalledTimes(1);
    expect(schedMutate.mock.calls[0]![0]).toMatchObject({ type: 'assr', id: '123', scheduleDate: '2026-11-20', jobKind: 'delivery' });
    expect(fieldsMutate).not.toHaveBeenCalled();
  });

  test('keeps a free-text reason already on the leg selectable', () => {
    render(<SetJobDateDrawer order={leg({ amend_reason: 'Customer asked to postpone' })} onClose={vi.fn()} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('Customer asked to postpone');
    expect(screen.getByRole('option', { name: 'Customer asked to postpone' })).toBeTruthy();
  });
});
