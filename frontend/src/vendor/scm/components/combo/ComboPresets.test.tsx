/* New combo reads its presets from the server (Products > Combo Pricing >
 * Combos; the screen says "combo"), not a constant: only active presets are
 * offered, in the server's order; a piece the model does not make still
 * disables the row ("No CNR on this model"). The Combos list switches a preset
 * off, moves it by keyboard or drag, deletes it after a confirm naming it, puts
 * the order back when the save fails, and shows every failure on screen. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotifyProvider } from '../NotifyDialog';
import { ConfirmProvider } from '../ConfirmDialog';

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

const { NewComboDialog, DeleteDialog } = await import('./ComboDialogs');
const { PresetsDialog, presetsCsv, dropIndex } = await import('./PresetsDialog');

const wrap = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NotifyProvider><ConfirmProvider>{ui}</ConfirmProvider></NotifyProvider></QueryClientProvider>,
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

describe('the Combos list', () => {
  beforeEach(() => { fetchMock.mockClear(); notifyMock.mockClear(); });

  it('switches a preset off and moves one up with the arrow key on its handle', async () => {
    wrap(<PresetsDialog onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('L shape active'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets/p-1', expect.objectContaining({ method: 'PATCH' })));
    const patch = fetchMock.mock.calls.find((c) => c[0] === '/sofa-combo-presets/p-1')![1] as { body: string };
    expect(JSON.parse(patch.body)).toEqual({ active: false });
    fireEvent.keyDown(screen.getByRole('button', { name: /^Move L shape/ }), { key: 'ArrowUp' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets/reorder', expect.objectContaining({ method: 'POST' })));
    const order = fetchMock.mock.calls.find((c) => c[0] === '/sofa-combo-presets/reorder')![1] as { body: string };
    expect(JSON.parse(order.body)).toEqual({ ids: ['p-1', 'p-2', 'p-3'] });
  });

  it('shows the names without a position number', async () => {
    wrap(<PresetsDialog onClose={() => undefined} />);
    expect(await screen.findByText('L shape')).toBeTruthy();
    expect(screen.queryByText(/^\d+\. /)).toBeNull();
  });

  it('dragging a handle below the next row saves the new order', async () => {
    // jsdom has no PointerEvent, so a pointer event would carry no clientY.
    if (!('PointerEvent' in window)) {
      class PointerEventShim extends MouseEvent { pointerId = 1; }
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = PointerEventShim;
    }
    wrap(<PresetsDialog onClose={() => undefined} />);
    const handle = await screen.findByRole('button', { name: /^Move Corner set/ });
    const rows = screen.getAllByRole('button', { name: /^Move / }).map((b) => b.parentElement!);
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 50, height: 50, bottom: i * 50 + 50, left: 0, right: 0, width: 0, x: 0, y: i * 50, toJSON: () => ({}) });
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 25 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 80 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 80 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets/reorder', expect.objectContaining({ method: 'POST' })));
    const order = fetchMock.mock.calls.find((c) => c[0] === '/sofa-combo-presets/reorder')![1] as { body: string };
    expect(JSON.parse(order.body)).toEqual({ ids: ['p-1', 'p-2', 'p-3'] });
  });

  it('a failed reorder shows the reason and puts the list back', async () => {
    fetchMock.mockImplementationOnce(async () => ({ presets: PRESETS }));
    fetchMock.mockImplementationOnce(async () => { throw new Error('order_mismatch'); });
    wrap(<PresetsDialog onClose={() => undefined} />);
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Move L shape/ }), { key: 'ArrowUp' });
    await waitFor(() => expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'order_mismatch', tone: 'error' })));
    const names = screen.getAllByRole('button', { name: /^Move / }).map((b) => b.getAttribute('aria-label'));
    expect(names[0]).toMatch(/^Move Corner set/);
    expect(names[1]).toMatch(/^Move L shape/);
  });

  it('deletes a preset only after a confirm naming it', async () => {
    wrap(<PresetsDialog onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete L shape' }));
    expect(await screen.findByText("Delete combo 'L shape'?")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith('/sofa-combo-presets/p-1', expect.objectContaining({ method: 'DELETE' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/sofa-combo-presets/p-1', expect.objectContaining({ method: 'DELETE' })));
  });

  it('a failed delete shows the reason', async () => {
    fetchMock.mockImplementationOnce(async () => ({ presets: PRESETS }));
    fetchMock.mockImplementationOnce(async () => { throw new Error('not_found_in_company'); });
    wrap(<PresetsDialog onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Retired' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't delete this combo", tone: 'error' })));
  });

  it('a drop lands on the row whose middle the pointer passed', () => {
    const middles = [25, 75, 125, 175];
    expect(dropIndex(middles, 80, 0)).toBe(1);
    expect(dropIndex(middles, 200, 0)).toBe(3);
    expect(dropIndex(middles, 60, 2)).toBe(1);
    expect(dropIndex(middles, 10, 3)).toBe(0);
    expect(dropIndex(middles, 130, 2)).toBe(2);
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

describe('deleting combos from a model', () => {
  beforeEach(() => { fetchMock.mockClear(); notifyMock.mockClear(); });
  const line = (name: string, modules: string[][]) => ({ key: name, baseModel: '8038', modules, label: name, name, byTier: {} });
  const chosen = [line('1S + 2S', [['1S'], ['2S']]), line('L shape', [['2A(LHF)'], ['L(RHF)']])];

  it('names the model and the combos, then retires them on every Price', async () => {
    const done = vi.fn();
    wrap(<DeleteDialog chosen={chosen} modelName="8038 DISCOVERY" supplierId={null} onDone={done} onClose={() => undefined} />);
    expect(screen.getByText('Delete 2 combos from 8038 DISCOVERY?')).toBeTruthy();
    expect(screen.getByText('1S + 2S, L shape')).toBeTruthy();
    expect(screen.getByText(/Their prices on Price 1 to 4 go with them/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('2 combos deleted.'));
    const call = fetchMock.mock.calls.find((c) => c[0] === '/sofa-combos/retire')![1] as { body: string };
    expect(JSON.parse(call.body)).toEqual({ items: chosen.map((l) => ({ baseModel: '8038', modules: l.modules })), supplierId: null });
  });

  it('a failed delete shows the reason and keeps the dialog', async () => {
    fetchMock.mockImplementationOnce(async () => { throw new Error('not_found_in_company'); });
    const done = vi.fn();
    wrap(<DeleteDialog chosen={chosen.slice(0, 1)} modelName="8038 DISCOVERY" supplierId={null} onDone={done} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText("Couldn't delete these combos")).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
  });
});
