import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { PackingListRow, PackingListsResponse, PackingRegionRow, PackingRegionsResponse } from '../lib/packing-list-queries';

const state: { data: PackingListsResponse | undefined; isLoading: boolean; error: unknown; lastDate: string | null } = {
  data: undefined, isLoading: false, error: null, lastDate: null,
};

vi.mock('../lib/packing-list-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/packing-list-queries')>()),
  usePackingLists: (opts: { date: string | null }) => { state.lastDate = opts.date; return state; },
  usePackingScanStatus: (date: string | null) => { scanState.lastDate = date; return scanState; },
  usePackingRegions: (opts: { unassignedOnly: boolean; enabled: boolean }) => {
    regionState.lastUnassigned = opts.unassignedOnly;
    regionState.lastEnabled = opts.enabled;
    return regionState;
  },
}));

const scanState: { data: { date: string; sheets: Array<{ kind: 'lorry' | 'region'; key: string; prepared_at: string | null; loaded_at: string | null; parts_total?: number; parts_prepared?: number; parts_loaded?: number }> } | undefined; lastDate: string | null } = {
  data: undefined, lastDate: null,
};

const regionState: {
  data: PackingRegionsResponse | undefined; isLoading: boolean; error: unknown;
  lastUnassigned: boolean | null; lastEnabled: boolean | null;
} = { data: undefined, isLoading: false, error: null, lastUnassigned: null, lastEnabled: null };

const printAll = vi.fn(async () => {});
const printOne = vi.fn(async () => {});
const printRegions = vi.fn(async () => {});
vi.mock('../lib/packing-list-pdf', () => ({ generatePackingListsPdf: printAll, generatePackingListPdf: printOne, generatePackingRegionsPdf: printRegions }));

const { DoPackingListsView } = await import('./DoPackingListsView');
const { MobilePackingLists } = await import('../../../mobile/MobilePackingLists');

afterEach(() => {
  cleanup();
  state.data = undefined; state.error = null; state.lastDate = null;
  scanState.data = undefined; scanState.lastDate = null;
  printAll.mockClear(); printOne.mockClear(); printRegions.mockClear();
  regionState.data = undefined; regionState.error = null; regionState.lastUnassigned = null; regionState.lastEnabled = null;
});

const regionRow = (over: Partial<PackingRegionRow>): PackingRegionRow => ({
  region: 'KL', label: 'KL/SEL', do_count: 9, customer_count: 9, units: 35,
  lorry_plates: ['VJK 8821', 'WXY 1234'], not_arranged: 3,
  dos: [{
    do_id: 'd1', do_number: 'DO-1', do_status: 'DRAFT', so_doc_no: 'SO-1', debtor_code: 'C1', customer_name: 'A', address: null, phone: null,
    time_range: null, m3_milli: null, lorry_plate: 'VJK 8821', driver_name: null, driver_phone: null, helper_1_name: null, helper_2_name: null,
    trip_no: null, trip_stop_no: null, state: 'Selangor', country: null, units: 3,
    items: [
      { line_no: 1, item_code: 'M', description: null, qty: 2, rack: null, rack_locked: false, po: null, po_locked: false, worked_out: false, item_group: 'mattress', variants: null, description2: null, so_line_no: 1 },
      { line_no: 2, item_code: 'S', description: null, qty: 1, rack: null, rack_locked: false, po: null, po_locked: false, worked_out: false, item_group: 'sofa', variants: null, description2: null, so_line_no: 2 },
    ],
  }],
  ...over,
});

const row = (over: Partial<PackingListRow>): PackingListRow => ({
  trip_id: 't1', trip_no: 'TRIP-1', trip_date: '2026-11-28', trip_status: 'PLANNED', source: 'trip',
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

describe('Packing Lists tab — By region', () => {
  it('the toggle writes view=region into the URL and the region query only runs then', () => {
    state.data = { date: '2026-11-28', lists: [row({})] };
    render(<MemoryRouter initialEntries={['/x?tab=packing&date=2026-11-28']}><DoPackingListsView /><Where /></MemoryRouter>);
    expect(regionState.lastEnabled).toBe(false);
    expect(screen.queryByLabelText('Only DOs not on a lorry yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /By region/ }));
    expect(screen.getByTestId('where').textContent).toMatch(/view=region/);
    expect(regionState.lastEnabled).toBe(true);
    expect(screen.queryByLabelText('Only DOs not on a lorry yet')).toBeNull();
  });

  it('one row per region with its lorries and category counts; Print all sends every region', async () => {
    const regions = [regionRow({}), regionRow({ region: 'SOUTHERN', label: 'Southern', lorry_plates: [], not_arranged: 1 })];
    regionState.data = { date: '2026-11-28', unassigned_only: false, regions };
    render(<MemoryRouter initialEntries={['/x?tab=packing&date=2026-11-28&view=region']}><DoPackingListsView /></MemoryRouter>);
    expect(screen.getByText('KL/SEL')).toBeTruthy();
    expect(screen.getByText('VJK 8821, WXY 1234, 3 not arranged')).toBeTruthy();
    expect(screen.getByText('1 not arranged')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Sofa pcs/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Print all 2 regions/ }));
    await waitFor(() => expect(printRegions).toHaveBeenCalledWith(regions, { date: '2026-11-28', action: 'print' }));
    const open = screen.getAllByRole('button', { name: 'Open' })[1] as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await waitFor(() => expect(printRegions).toHaveBeenCalledWith([regions[1]], { date: '2026-11-28', action: 'preview' }));
  });

  it('By region always lists every DO, lorry or not; Download all saves every region', async () => {
    const regions = [regionRow({})];
    regionState.data = { date: '2026-11-28', unassigned_only: false, regions };
    render(<MemoryRouter initialEntries={['/x?tab=packing&date=2026-11-28&view=region&unassigned=1']}><DoPackingListsView /></MemoryRouter>);
    expect(regionState.lastUnassigned).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Download all 1 region/ }));
    await waitFor(() => expect(printRegions).toHaveBeenCalledWith(regions, { date: '2026-11-28', action: 'save' }));
  });
});

describe('phone — Packing lists card on Delivery Orders', () => {
  it('By region lists the regions and prints them all into one preview', async () => {
    const regions = [regionRow({})];
    regionState.data = { date: '2026-11-28', unassigned_only: false, regions };
    state.data = { date: '2026-11-28', lists: [] };
    render(<MobilePackingLists />);
    fireEvent.click(screen.getByRole('button', { name: 'By region' }));
    expect(screen.getByText('KL/SEL')).toBeTruthy();
    expect(screen.getByText('9 DO · 9 customers · 35 units')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Print all 1 region$/ }));
    await waitFor(() => expect(printRegions).toHaveBeenCalledWith(regions, expect.objectContaining({ action: 'preview' })));
  });

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

describe('Prepared and Loaded on the Packing Lists tab (owner 2026-11-28)', () => {
  const SHEETS = {
    date: '2026-11-28',
    sheets: [
      { kind: 'lorry' as const, key: 'VJK8821', prepared_at: '2026-11-28T01:42:00Z', loaded_at: '2026-11-28T03:05:00Z' },
      { kind: 'lorry' as const, key: 'WXY1234', prepared_at: '2026-11-27T10:15:00Z', loaded_at: null },
      { kind: 'region' as const, key: 'KL', prepared_at: '2026-11-28T00:50:00Z', loaded_at: null },
    ],
  };

  it('By lorry: each lorry shows its prepared and loaded time in Malaysia time, matched by plate', () => {
    scanState.data = SHEETS;
    state.data = { date: '2026-11-28', lists: [row({}), row({ trip_id: 't2', lorry_plate: 'wxy-1234' }), row({ trip_id: 't3', lorry_plate: 'BNM 5520' })] };
    render(<MemoryRouter initialEntries={['/scm/delivery-orders?tab=packing&date=2026-11-28']}><DoPackingListsView /></MemoryRouter>);
    expect(scanState.lastDate).toBe('2026-11-28');
    expect(screen.getAllByText('Prepared').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Loaded').length).toBeGreaterThan(0);
    expect(screen.getByText('09:42')).toBeTruthy();
    expect(screen.getByText('11:05')).toBeTruthy();
    expect(screen.getByText('2026/11/27 18:15')).toBeTruthy();
    expect(screen.getAllByTitle(/Not scanned as/).length).toBe(3);
  });

  it('By region: each region shows its times, a dash when not scanned', () => {
    scanState.data = SHEETS;
    regionState.data = { date: '2026-11-28', unassigned_only: false, regions: [regionRow({}), regionRow({ region: 'JB', label: 'Johor' })] };
    render(<MemoryRouter initialEntries={['/scm/delivery-orders?tab=packing&date=2026-11-28&view=region']}><DoPackingListsView /></MemoryRouter>);
    expect(screen.getAllByText('Prepared').length).toBeGreaterThan(0);
    expect(screen.getByText('08:50')).toBeTruthy();
    expect(screen.getAllByTitle(/Not scanned as/).length).toBe(3);
  });

  it('a sheet over 60 DOs prints in parts: no part scanned yet reads 0 of 2 parts', () => {
    state.data = { date: '2026-11-28', lists: [row({ do_count: 61, source: 'crew' })] };
    render(<MemoryRouter initialEntries={['/scm/delivery-orders?tab=packing&date=2026-11-28']}><DoPackingListsView /></MemoryRouter>);
    expect(screen.getAllByText('0 of 2 parts')).toHaveLength(2);
    expect(screen.queryByText(/No QR/)).toBeNull();
  });

  it('a lorry in parts shows how many parts are scanned, and the time once all are', () => {
    scanState.data = {
      date: '2026-11-28',
      sheets: [{ kind: 'lorry', key: 'VJK8821', prepared_at: '2026-11-28T01:42:00Z', loaded_at: null, parts_total: 2, parts_prepared: 2, parts_loaded: 1 }],
    };
    state.data = { date: '2026-11-28', lists: [row({ do_count: 70, source: 'crew' })] };
    render(<MemoryRouter initialEntries={['/scm/delivery-orders?tab=packing&date=2026-11-28']}><DoPackingListsView /></MemoryRouter>);
    expect(screen.getByText('09:42')).toBeTruthy();
    expect(screen.getByText('1 of 2 parts')).toBeTruthy();
  });

  it('the phone card shows the same times per lorry and region', () => {
    scanState.data = SHEETS;
    state.data = { date: '2026-11-28', lists: [row({})] };
    render(<MemoryRouter><MobilePackingLists /></MemoryRouter>);
    expect(screen.getByText(/Prepared .* · Loaded /)).toBeTruthy();
  });
});
