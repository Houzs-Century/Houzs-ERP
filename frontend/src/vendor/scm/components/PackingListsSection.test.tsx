/* The Packing Lists surface under Last Mile Delivery.
 *
 * Two things are worth asserting here and the rest is layout:
 *
 *   1. ONE ROW PER TRIP. A packing list IS a trip — one lorry, one day — so
 *      three lorries out must produce three rows, and the row must name the
 *      lorry, the driver and the counts a dispatcher checks before printing.
 *   2. AN EMPTY BUCKET RENDERS A DASH, NOT A ZERO. A run whose delivery orders
 *      the company predicate filtered out looks exactly like a run with nothing
 *      on it, so the status chip and the volume both refuse rather than
 *      inventing "Delivered 0/0" and "0.00 m³".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { PackingListRow, PackingListsResponse } from '../lib/packing-list-queries';

const state: { data: PackingListsResponse | undefined; isLoading: boolean; error: unknown } = {
  data: undefined, isLoading: false, error: null,
};

vi.mock('../lib/packing-list-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/packing-list-queries')>()),
  usePackingLists: () => state,
}));

const { PackingListsSection } = await import('./PackingListsSection');

afterEach(() => {
  cleanup();
  state.data = undefined; state.isLoading = false; state.error = null;
});

const row = (over: Partial<PackingListRow>): PackingListRow => ({
  trip_id: 'trip-1',
  trip_no: 'TRIP-2608-001',
  trip_date: '2026-08-26',
  trip_status: 'PLANNED',
  lorry_plate: 'WXY 1234',
  driver_name: 'Ah Meng',
  warehouse_name: 'Main Depot',
  stop_count: 3,
  do_count: 3,
  units: 6,
  m3_milli: 3400,
  stops: [
    { stop_no: 1, stop_type: 'DELIVERY', customer_name: 'Alpha', address: null, do_id: 'a', do_number: 'DO-1', do_status: 'DISPATCHED', do_missing: false, units: 2, items: [] },
    { stop_no: 2, stop_type: 'DELIVERY', customer_name: 'Bravo', address: null, do_id: 'b', do_number: 'DO-2', do_status: 'DISPATCHED', do_missing: false, units: 2, items: [] },
    { stop_no: 3, stop_type: 'DELIVERY', customer_name: 'Charlie', address: null, do_id: 'c', do_number: 'DO-3', do_status: 'LOADED', do_missing: false, units: 2, items: [] },
  ],
  ...over,
});

describe('PackingListsSection', () => {
  it('renders one row per trip of the day', () => {
    state.data = {
      date: '2026-08-26',
      lists: [
        row({}),
        row({ trip_id: 't2', trip_no: 'TRIP-2608-002', lorry_plate: 'ABC 999' }),
        row({ trip_id: 't3', trip_no: 'TRIP-2608-003', lorry_plate: 'DEF 111' }),
      ],
    };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText('TRIP-2608-001')).toBeTruthy();
    expect(screen.getByText('ABC 999')).toBeTruthy();
    expect(screen.getByText('DEF 111')).toBeTruthy();
    expect(screen.getAllByRole('row').length).toBe(4); // header + three trips
  });

  it('rolls the member delivery orders up into the owner ladder', () => {
    state.data = { date: '2026-08-26', lists: [row({})] };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText('Loaded 2/3')).toBeTruthy();
  });

  it('shows a dash — never a confident zero — when no delivery order could be read', () => {
    state.data = {
      date: '2026-08-26',
      lists: [row({
        do_count: 0,
        units: 0,
        m3_milli: null,
        stops: [{ stop_no: 1, stop_type: 'DELIVERY', customer_name: 'Alpha', address: null, do_id: 'a', do_number: null, do_status: null, do_missing: true, units: 0, items: [] }],
      })],
    };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    const body = screen.getAllByRole('row')[1];
    expect(within(body).queryByText(/Delivered 0\/0/)).toBeNull();
    expect(within(body).queryByText(/0\.00 m³/)).toBeNull();
    expect(within(body).getAllByText('—').length).toBeGreaterThanOrEqual(2); // status + volume
  });

  it('reports what it looked for when the day has no trips, and claims nothing about the business', () => {
    state.data = { date: '2026-08-26', lists: [] };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText(/This day has no trips\./)).toBeTruthy();
  });

  it('surfaces a failed read as a failure rather than as an empty day', () => {
    state.error = new Error('load_failed');
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText(/Could not load the packing lists/)).toBeTruthy();
    expect(screen.queryByText(/This day has no trips\./)).toBeNull();
  });
});
