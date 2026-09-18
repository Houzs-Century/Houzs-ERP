/* After a Stock Transfer or Stock Adjustment saves, the next step is offered
   the way GRN and Purchase Invoice already offer it: open what was saved, or
   start another (staff request 2026-09-14).

   THE TRAP THIS PINS. StockTransferNew mints ONE idempotency key per mount
   (lib/idempotency.ts). A "New stock transfer" that navigated to
   /scm/stock-transfers/new from /scm/stock-transfers/new is a no-op for the
   router: the page would not remount, the key would not rotate, and the
   operator's SECOND, different transfer would go out under the FIRST one's key
   — the server answers that with a replay of transfer #1 or a 409
   idempotency_key_reused, and no second transfer is written. GrnNew.tsx carries
   the long form of this warning. So "New" must remount the form: the test
   posts twice across a "New" and asserts the two requests carry DIFFERENT
   keys, with the real useIdempotencyKey (not a stub). */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type TransferCall = { idempotencyKey?: string; fromWarehouseId: string; toWarehouseId: string; items: Array<{ itemCode: string; qty: number }> };
const transferCalls: TransferCall[] = [];
const adjustCalls: Array<{ warehouseId: string; itemCode: string; qtyDelta: number; reasonCode: string }> = [];

vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>()),
  useInventoryBuckets: (itemCode: string | null, warehouseId: string | null) => ({
    data: itemCode && warehouseId ? [{ warehouse_id: warehouseId, variant_key: '', batch_no: null, product_name: 'Chair', qty: 50 }] : [],
    isLoading: false,
  }),
  useInventoryProductBreakdown: () => ({ data: { balances: [] }, isLoading: false }),
  useCreateStockTransfer: () => ({
    isPending: false,
    mutate: (vars: TransferCall, opts: { onSuccess: (r: { id: string; transferNo: string }) => void }) => {
      transferCalls.push(vars);
      const n = transferCalls.length;
      opts.onSuccess({ id: `st-${n}`, transferNo: `ST-2609-00${n}` });
    },
  }),
  useStockAdjustment: () => ({
    isPending: false,
    mutate: (vars: (typeof adjustCalls)[number], opts: { onSuccess: (r: { movement: { id: string } }) => void }) => {
      adjustCalls.push(vars);
      opts.onSuccess({ movement: { id: `mv-${adjustCalls.length}` } });
    },
    // StockAdjustmentNew's multi-item Save loop posts each item sequentially
    // via mutateAsync (owner 2026-09-18) — react-query's real useMutation
    // always provides both; this stub needs to as well.
    mutateAsync: async (vars: (typeof adjustCalls)[number]) => {
      adjustCalls.push(vars);
      return { movement: { id: `mv-${adjustCalls.length}` } };
    },
  }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A' }, { id: 'w2', code: 'WH-B' }], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 1, code: 'CH-1', name: 'Chair', category: 'ACCESSORY' }], isLoading: false }),
  useMaintenanceConfig: () => ({ data: null, isLoading: false }),
  useSpecialAddons: () => ({ data: [], isLoading: false }),
}));
const notify = vi.fn(async () => undefined);
vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => notify,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));

import { StockTransferNew } from './StockTransferNew';
import { StockAdjustmentNew } from './StockAdjustmentNew';

afterEach(() => {
  transferCalls.length = 0;
  adjustCalls.length = 0;
  notify.mockClear();
});

const select = (label: RegExp) => screen.getByLabelText(label) as HTMLSelectElement;

describe('StockTransferNew — the next step after Post', () => {
  const draw = () => render(
    <MemoryRouter initialEntries={['/scm/stock-transfers/new']}>
      <Routes>
        <Route path="/scm/stock-transfers/new" element={<StockTransferNew />} />
        <Route path="/scm/stock-transfers/:id" element={<div>transfer detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );

  const fillAndPost = (qty: string) => {
    fireEvent.change(select(/From Warehouse/), { target: { value: 'w1' } });
    fireEvent.change(select(/To Warehouse/), { target: { value: 'w2' } });
    fireEvent.change(screen.getByPlaceholderText('Type code…'), { target: { value: 'CH-1' } });
    const bucket = document.querySelector('tbody select') as HTMLSelectElement;
    fireEvent.change(bucket, { target: { value: '' } });
    fireEvent.change(document.querySelector('tbody input[type="number"]') as HTMLInputElement, { target: { value: qty } });
    fireEvent.click(screen.getByRole('button', { name: /Post Transfer/ }));
  };

  test('"New stock transfer" starts a blank form, and the second post carries a NEW idempotency key', () => {
    draw();
    fillAndPost('3');
    expect(transferCalls).toHaveLength(1);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/ST-2609-001/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'New stock transfer' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(select(/From Warehouse/).value).toBe('');
    expect(select(/To Warehouse/).value).toBe('');
    expect((screen.getByPlaceholderText('Type code…') as HTMLInputElement).value).toBe('');

    fillAndPost('7');
    expect(transferCalls).toHaveLength(2);
    expect(transferCalls[0]!.idempotencyKey).toBeTruthy();
    expect(transferCalls[1]!.idempotencyKey).toBeTruthy();
    expect(transferCalls[1]!.idempotencyKey).not.toBe(transferCalls[0]!.idempotencyKey);
    expect(transferCalls[1]!.items[0]!.qty).toBe(7);
  });

  test('"Open transfer" goes to the saved document', () => {
    draw();
    fillAndPost('3');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Open transfer' }));
    expect(screen.getByText('transfer detail page')).toBeTruthy();
  });

  test('closing the dialog cannot post the same transfer again', () => {
    draw();
    fillAndPost('3');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stay here' }));
    expect(screen.queryByRole('button', { name: /Post Transfer/ })).toBeNull();
    expect(screen.getByRole('button', { name: /New stock transfer/ })).toBeTruthy();
    expect(transferCalls).toHaveLength(1);
  });
});

describe('StockAdjustmentNew — the next step after Save', () => {
  const draw = () => render(
    <MemoryRouter initialEntries={['/scm/stock-adjustments/new']}>
      <Routes>
        <Route path="/scm/stock-adjustments/new" element={<StockAdjustmentNew />} />
        <Route path="/scm/stock-adjustments" element={<div>adjustments list page</div>} />
      </Routes>
    </MemoryRouter>,
  );

  const fillAndSave = (qty: string) => {
    fireEvent.change(select(/^Warehouse \*/), { target: { value: 'w1' } });
    fireEvent.change(screen.getByPlaceholderText('Type or pick a SKU code…'), { target: { value: 'CH-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Increase/ }));
    fireEvent.change(screen.getByLabelText(/Qty \*/), { target: { value: qty } });
    fireEvent.change(select(/Reason \*/), { target: { value: 'FOUND' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Adjustment/ }));
  };

  test('"New stock adjustment" starts a blank form and saves a second adjustment', async () => {
    draw();
    fillAndSave('2');
    await screen.findByRole('dialog');
    expect(adjustCalls).toHaveLength(1);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'New stock adjustment' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(select(/^Warehouse \*/).value).toBe('');
    expect(select(/Reason \*/).value).toBe('');

    fillAndSave('5');
    await screen.findByRole('dialog');
    expect(adjustCalls).toHaveLength(2);
    expect(adjustCalls[1]!.qtyDelta).toBe(5);
  });

  test('"Open stock adjustments" goes to the list, where adjustments are read', async () => {
    draw();
    fillAndSave('2');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Open stock adjustments' }));
    expect(screen.getByText('adjustments list page')).toBeTruthy();
  });
});
