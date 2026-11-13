/* New combo reads its presets from the server (Products > Combo Pricing >
 * Presets), not a constant: only active presets are offered, in the server's
 * order; a piece the model does not make still disables the row ("No CNR on
 * this model"). The Presets list switches a preset off and reorders it, and a
 * failed save shows on screen. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotifyProvider } from '../NotifyDialog';

const PRESETS = [
  { id: 'p-2', name: 'Corner set', slots: [['2A'], ['CNR'], ['1A']], sortOrder: 0, active: true },
  { id: 'p-1', name: 'L shape', slots: [['2A'], ['L']], sortOrder: 1, active: true },
  { id: 'p-3', name: 'Retired', slots: [['1S']], sortOrder: 2, active: false },
];

const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
  if (url === '/sofa-combo-presets' && !init?.method) return { presets: PRESETS };
  return {};
});
vi.mock('../../lib/authed-fetch', () => ({ authedFetch: (u: string, i?: { method?: string }) => fetchMock(u, i) }));

const notifyMock = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../../lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notifyMock(o) }));

const { NewComboDialog } = await import('./ComboDialogs');
const { PresetsDialog, presetsCsv } = await import('./PresetsDialog');

const wrap = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NotifyProvider>{ui}</NotifyProvider></QueryClientProvider>,
);

describe('New combo, Start from: Preset', () => {
  beforeEach(() => { fetchMock.mockClear(); });

  it('offers the active presets from the server, in order, and disables one the model cannot make', async () => {
    wrap(
      <NewComboDialog
        model="5030"
        lines={[]}
        sourceBook={new Map()}
        ownModules={['1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']}
        supplierId={null}
        today="2026-11-12"
        onHand={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText('Corner set')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets', undefined);
    const names = screen.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent ?? '');
    expect(names).toHaveLength(2);
    expect(names[0]).toContain('Corner set');
    expect(names[1]).toContain('L shape');
    expect(screen.queryByText('Retired')).toBeNull();
    expect(screen.getByText('No CNR on this model')).toBeTruthy();
    const [corner, lShape] = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(corner.disabled).toBe(true);
    expect(lShape.disabled).toBe(false);
    expect(screen.getByText('2A + L')).toBeTruthy();
  });
});

describe('the Presets list', () => {
  beforeEach(() => { fetchMock.mockClear(); notifyMock.mockClear(); });

  it('switches a preset off and moves one up', async () => {
    wrap(<PresetsDialog onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('L shape active'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets/p-1', expect.objectContaining({ method: 'PATCH' })));
    const patch = fetchMock.mock.calls.find((c) => c[0] === '/sofa-combo-presets/p-1')![1] as { body: string };
    expect(JSON.parse(patch.body)).toEqual({ active: false });
    fireEvent.click(screen.getByRole('button', { name: 'Move L shape up' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets/reorder', expect.objectContaining({ method: 'POST' })));
    const order = fetchMock.mock.calls.find((c) => c[0] === '/sofa-combo-presets/reorder')![1] as { body: string };
    expect(JSON.parse(order.body)).toEqual({ ids: ['p-1', 'p-2', 'p-3'] });
  });

  it('a failed save shows the server\'s reason', async () => {
    fetchMock.mockImplementationOnce(async () => ({ presets: PRESETS }));
    fetchMock.mockImplementationOnce(async () => { throw new Error('missing_scm_config_write'); });
    wrap(<PresetsDialog onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Corner set active'));
    await waitFor(() => expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'missing_scm_config_write', tone: 'error' })));
  });

  it('exports the list as CSV, in order', () => {
    expect(presetsCsv(PRESETS).split('\r\n')).toEqual([
      'Order,Name,Compartments,Active',
      '1,Corner set,2A + CNR + 1A,Yes',
      '2,L shape,2A + L,Yes',
      '3,Retired,1S,No',
    ]);
  });
});
