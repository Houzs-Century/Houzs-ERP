import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import type { PackingListRow, PackingListsResponse } from '../lib/packing-list-queries';

const state: { data: PackingListsResponse | undefined; isLoading: boolean; error: unknown } = {
  data: undefined, isLoading: false, error: null,
};

vi.mock('../lib/packing-list-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/packing-list-queries')>()),
  usePackingLists: () => state,
}));

const printAll = vi.fn(async () => {});
const printOne = vi.fn(async () => {});
vi.mock('../lib/packing-list-pdf', () => ({ generatePackingListsPdf: printAll, generatePackingListPdf: printOne }));

const { PackingListsSection } = await import('./PackingListsSection');

afterEach(() => {
  cleanup();
  state.data = undefined; state.isLoading = false; state.error = null;
  printAll.mockClear(); printOne.mockClear();
});

const row = (over: Partial<PackingListRow>): PackingListRow => ({
  trip_id: 'trip-1',
  source: 'trip',
  trip_no: 'TRIP-2608-001',
  trip_date: '2026-08-26',
  trip_status: 'PLANNED',
  lorry_plate: 'WXY 1234',
  driver_name: 'Ah Meng',
  driver_phone: null,
  helper_1_name: null,
  helper_2_name: null,
  warehouse_name: 'Main Depot',
  stop_count: 3,
  do_count: 3,
  units: 6,
  m3_milli: 3400,
  stops: [
    { stop_no: 1, stop_type: 'DELIVERY', customer_name: 'Alpha', address: null, do_id: 'a', do_number: 'DO-1', do_status: 'DISPATCHED', do_missing: false, so_doc_no: null, phone: null, time_range: null, units: 2, items: [] },
    { stop_no: 2, stop_type: 'DELIVERY', customer_name: 'Bravo', address: null, do_id: 'b', do_number: 'DO-2', do_status: 'DISPATCHED', do_missing: false, so_doc_no: null, phone: null, time_range: null, units: 2, items: [] },
    { stop_no: 3, stop_type: 'DELIVERY', customer_name: 'Charlie', address: null, do_id: 'c', do_number: 'DO-3', do_status: 'LOADED', do_missing: false, so_doc_no: null, phone: null, time_range: null, units: 2, items: [] },
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
    expect(screen.getAllByRole('row').length).toBe(4);
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
        stops: [{ stop_no: 1, stop_type: 'DELIVERY', customer_name: 'Alpha', address: null, do_id: 'a', do_number: null, do_status: null, do_missing: true, so_doc_no: null, phone: null, time_range: null, units: 0, items: [] }],
      })],
    };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    const body = screen.getAllByRole('row')[1];
    expect(within(body).queryByText(/Delivered 0\/0/)).toBeNull();
    expect(within(body).queryByText(/0\.00 m³/)).toBeNull();
    expect(within(body).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('reports what it looked for when the day has no lorries, and claims nothing about the business', () => {
    state.data = { date: '2026-08-26', lists: [] };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText(/No lorry has delivery orders on this day yet\./)).toBeTruthy();
  });

  it('a lorry from the board crew (no trip) is listed but offers no scan QR', () => {
    state.data = { date: '2026-08-26', lists: [row({}), row({ trip_id: 'crew:BNM 5520', trip_no: null, lorry_plate: 'BNM 5520', source: 'crew' })] };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText('BNM 5520')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'QR' })).toHaveLength(1);
  });

  it('surfaces a failed read as a failure rather than as an empty day', () => {
    state.error = new Error('load_failed');
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect(screen.getByText(/Could not load the packing lists/)).toBeTruthy();
    expect(screen.queryByText(/This day has no trips\./)).toBeNull();
  });

  it('prints every lorry of the day into one file from one button', async () => {
    const lists = [row({}), row({ trip_id: 't2', lorry_plate: 'ABC 999' })];
    state.data = { date: '2026-08-26', lists };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Print all for 2026\/08\/26/ }));
    await waitFor(() => expect(printAll).toHaveBeenCalledTimes(1));
    expect(printAll).toHaveBeenCalledWith(lists, { date: '2026-08-26', action: 'print' });
  });

  it('offers no print-all when the day has no lorries', () => {
    state.data = { date: '2026-08-26', lists: [] };
    render(<PackingListsSection date="2026-08-26" warehouseId={null} />);
    expect((screen.getByRole('button', { name: /Print all for/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
