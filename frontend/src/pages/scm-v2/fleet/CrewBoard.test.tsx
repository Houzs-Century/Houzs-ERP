
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch }));

const { DriversSection } = await import('./CrewBoard');
const { DeliveryResidenceRules } = await import('../DeliveryResidenceRules');
const { ConfirmProvider } = await import('../../../vendor/scm/components/ConfirmDialog');
const { NotifyProvider } = await import('../../../vendor/scm/components/NotifyDialog');

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ConfirmProvider><NotifyProvider>{ui}</NotifyProvider></ConfirmProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

const DRIVER = {
  id: 'd1', driver_code: 'DRV-007', name: 'Ahmad Faiz', phone: '+60123334444', ic_number: null, vehicle: null,
  in_house: false, threepl_company_id: 'c1', active: true, created_at: '', warehouse_id: 'w1',
  photo_r2_key: null, license_no: 'D1234567', license_expiry: '2027-05-01', address: '12 Jalan Satu',
  emergency_contact_name: 'Siti', emergency_contact_phone: '011-9',
};

const reads: Record<string, unknown> = {
  '/drivers': { drivers: [DRIVER] },
  '/lorries': { lorries: [{ id: 'l1', plate: 'VQE9058', type: 'LORRY_17FT', active: true, usual_driver_id: 'd1', created_at: '' }] },
  '/inventory/warehouses': { warehouses: [{ id: 'w1', code: 'BKG', name: 'BALAKONG WAREHOUSE' }] },
  '/threepl-companies': { companies: [{ id: 'c1', name: 'MSJ Transport' }] },
  '/driver-leave': { leave: [] },
};

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation((path: string, opts?: { method?: string }) => {
    if (opts?.method) return Promise.resolve({ driver: DRIVER });
    const key = path.split('?')[0]!;
    return key in reads ? Promise.resolve(reads[key]) : Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe('Drivers tab', () => {
  test('a row shows employer, usual lorry and warehouse', async () => {
    wrap(<DriversSection />);
    expect((await screen.findAllByText('Ahmad Faiz')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Outsource · MSJ Transport')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('VQE9058')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('BALAKONG WAREHOUSE')).length).toBeGreaterThan(0);
  });

  test('the drawer edits and sends only the changed field', async () => {
    wrap(<DriversSection />);
    fireEvent.click((await screen.findAllByText('Ahmad Faiz'))[0]!);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Hilux WMN1234'), { target: { value: 'Hilux WMN1' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/drivers/d1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ vehicle: 'Hilux WMN1' }) })));
  });

  test('the read view shows the office profile and "Not uploaded" with no photo', async () => {
    wrap(<DriversSection />);
    fireEvent.click((await screen.findAllByText('Ahmad Faiz'))[0]!);
    expect(await screen.findByText('Licence no.')).toBeTruthy();
    expect(screen.getByText('D1234567')).toBeTruthy();
    expect(screen.getByText('12 Jalan Satu')).toBeTruthy();
    expect(screen.getByText('Siti · 011-9')).toBeTruthy();
    expect(screen.getByText('Not uploaded')).toBeTruthy();
  });

  test('the drawer edits and sends the changed profile fields', async () => {
    wrap(<DriversSection />);
    fireEvent.click((await screen.findAllByText('Ahmad Faiz'))[0]!);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.change(screen.getByLabelText('Licence no.'), { target: { value: 'X99' } });
    fireEvent.change(screen.getByPlaceholderText('Home address'), { target: { value: 'New address' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => {
      const patch = authedFetch.mock.calls.find(([p, o]: [string, { method?: string }?]) => p === '/drivers/d1' && o?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({ licenseNo: 'X99', address: 'New address' });
    });
  });

  test('a failed load says so instead of claiming an empty list', async () => {
    reads['/drivers'] = undefined;
    authedFetch.mockImplementation((path: string) => (path.startsWith('/drivers') ? Promise.reject(new Error('boom')) : Promise.resolve(reads[path.split('?')[0]!] ?? {})));
    wrap(<DriversSection />);
    expect(await screen.findByText('The driver list could not be loaded.')).toBeTruthy();
    expect(screen.queryByText(/came back with no drivers/)).toBeNull();
    reads['/drivers'] = { drivers: [DRIVER] };
  });
});

describe('Residence rules, embedded', () => {
  test('still offers New Type', async () => {
    authedFetch.mockImplementation(() => Promise.resolve({ rules: [] }));
    wrap(<DeliveryResidenceRules embedded />);
    expect(await screen.findByText('New Type')).toBeTruthy();
  });
});
