import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { PackingListRow, PackingListsResponse } from '../lib/packing-list-queries';

const state: { data: PackingListsResponse | undefined; isLoading: boolean; error: unknown; lastDate: string | null } = {
  data: undefined, isLoading: false, error: null, lastDate: null,
};

vi.mock('../lib/packing-list-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/packing-list-queries')>()),
  usePackingLists: (opts: { date: string | null }) => { state.lastDate = opts.date; return state; },
}));

const printAll = vi.fn(async () => {});
const printOne = vi.fn(async () => {});
vi.mock('../lib/packing-list-pdf', () => ({ generatePackingListsPdf: printAll, generatePackingListPdf: printOne }));

const { DoPackingListsView } = await import('./DoPackingListsView');
const { MobilePackingLists } = await import('../../../mobile/MobilePackingLists');

afterEach(() => {
  cleanup();
  state.data = undefined; state.error = null; state.lastDate = null;
  printAll.mockClear(); printOne.mockClear();
});

const row = (over: Partial<PackingListRow>): PackingListRow => ({
  trip_id: 't1', trip_no: 'TRIP-1', trip_date: '2026-11-28', trip_status: 'PLANNED',
  lorry_plate: 'VJK 8821', driver_name: 'Ah Meng', driver_phone: null,
  helper_1_name: 'Raju', helper_2_name: 'Kumar', warehouse_name: 'HQ',
  stop_count: 6, do_count: 6, units: 27, m3_milli: 11620, stops: [], ...over,
});

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.search}</span>;
}

describe('Delivery Orders — Packing Lists tab', () => {
  it('reads the date from the URL and lists one row per lorry with its crew', () => {
    state.data = { date: '2026-11-28', lists: [row({}), row({ trip_id: 't2', lorry_plate: 'WXY 1234', helper_2_name: null })] };
    render(<MemoryRouter initialEntries={['/scm/delivery-orders?tab=packing&date=2026-11-28']}><DoPackingListsView /></MemoryRouter>);
    expect(state.lastDate).toBe('2026-11-28');
    expect(screen.getByText('VJK 8821')).toBeTruthy();
    expect(screen.getByText('Raju, Kumar')).toBeTruthy();
    expect(screen.getAllByText('11.62')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Print all 2 lorries/ })).toBeTruthy();
  });

  it('Print all sends every lorry of the day to one print job; Open previews one', async () => {
    const lists = [row({}), row({ trip_id: 't2', lorry_plate: 'WXY 1234' })];
    state.data = { date: '2026-11-28', lists };
    render(<MemoryRouter initialEntries={['/x?tab=packing&date=2026-11-28']}><DoPackingListsView /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Print all 2 lorries/ }));
    await waitFor(() => expect(printAll).toHaveBeenCalledWith(lists, { date: '2026-11-28', action: 'print' }));
    const open = screen.getAllByRole('button', { name: 'Open' })[0] as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await waitFor(() => expect(printOne).toHaveBeenCalledWith(lists[0], { date: '2026-11-28', action: 'preview' }));
  });

  it('a quick-day button writes the date into the URL', () => {
    state.data = { date: '2026-11-28', lists: [] };
    render(<MemoryRouter initialEntries={['/x?tab=packing&date=2026-11-28']}><DoPackingListsView /><Where /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    expect(screen.getByTestId('where').textContent).toMatch(/tab=packing/);
    expect((screen.getByRole('button', { name: /Print all 0 lorries/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('phone — Packing lists card on Delivery Orders', () => {
  it('prints every lorry into one PDF preview', async () => {
    const lists = [row({}), row({ trip_id: 't2', lorry_plate: 'WXY 1234', stop_count: 1, units: 1 })];
    state.data = { date: '2026-11-28', lists };
    render(<MobilePackingLists />);
    expect(screen.getByText('WXY 1234')).toBeTruthy();
    expect(screen.getByText(/1 customer · 1 unit$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Print all 2 lorries/ }));
    await waitFor(() => expect(printAll).toHaveBeenCalledTimes(1));
    expect((printAll.mock.calls[0] as unknown[])[0]).toBe(lists);
  });
});
