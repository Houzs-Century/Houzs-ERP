/* Phone twin of pages/scm-v2/stock-new-next-step.test.tsx. After a transfer
   is created the phone offers "New stock transfer" beside "Done", and "New"
   must REMOUNT the screen so the next transfer gets its own idempotency key —
   resetting the fields by hand would leave the first transfer's key in place
   and the second, different transfer would be answered with the first one's
   replay. Real useIdempotencyKey, real ConfirmProvider. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

type TransferCall = { idempotencyKey?: string; fromWarehouseId: string; items: Array<{ qty: number }> };
const calls: TransferCall[] = [];

vi.mock('../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/stock-queries')>()),
  useInventoryBuckets: (itemCode: string | null, warehouseId: string | null) => ({
    data: itemCode && warehouseId ? [{ warehouse_id: warehouseId, variant_key: '', batch_no: null, product_name: 'Chair', qty: 50 }] : [],
    isLoading: false,
  }),
  useCreateStockTransfer: () => ({
    isPending: false,
    mutate: (vars: TransferCall, opts: { onSuccess: (r: { id: string; transferNo: string }) => void }) => {
      calls.push(vars);
      opts.onSuccess({ id: `st-${calls.length}`, transferNo: `ST-2609-00${calls.length}` });
    },
  }),
}));
vi.mock('../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A' }, { id: 'w2', code: 'WH-B' }], isLoading: false }),
}));
vi.mock('./MobileSkuPicker', () => ({
  MobileSkuPicker: ({ onPick }: { onPick: (s: { itemCode: string; itemGroup: string; name: string; unitPriceSen: number; category: string }) => void }) => (
    <button type="button" onClick={() => onPick({ itemCode: 'CH-1', itemGroup: 'accessory', name: 'Chair', unitPriceSen: 0, category: 'ACCESSORY' })}>pick CH-1</button>
  ),
}));
const notify = vi.fn(async () => undefined);
vi.mock('../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => notify,
}));

import { ConfirmProvider } from '../vendor/scm/components/ConfirmDialog';
import { MobileStockTransferNew } from './MobileStockTransferNew';

afterEach(() => {
  calls.length = 0;
  notify.mockClear();
});

const selects = () => [...document.querySelectorAll('select')] as HTMLSelectElement[];

const fillAndCreate = () => {
  fireEvent.change(selects()[0]!, { target: { value: 'w1' } });
  fireEvent.change(selects()[1]!, { target: { value: 'w2' } });
  fireEvent.click(screen.getByText('+ Add item'));
  fireEvent.click(screen.getByText('pick CH-1'));
  fireEvent.change(selects()[2]!, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create transfer' }));
};

describe('MobileStockTransferNew — the next step after Create', () => {
  test('"New stock transfer" starts a blank screen and the second create carries a NEW idempotency key', async () => {
    const onCreated = vi.fn();
    render(<ConfirmProvider><MobileStockTransferNew onBack={() => {}} onCreated={onCreated} /></ConfirmProvider>);
    fillAndCreate();
    expect(calls).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: 'New stock transfer' }));
    await waitFor(() => expect(selects()[0]!.value).toBe(''));
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.st-line')).toHaveLength(0);

    fillAndCreate();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBeTruthy();
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
  });

  test('"Done" leaves the way it always did', async () => {
    const onCreated = vi.fn();
    render(<ConfirmProvider><MobileStockTransferNew onBack={() => {}} onCreated={onCreated} /></ConfirmProvider>);
    fillAndCreate();
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  test('a line Remarks typed before Create is sent as that line\'s notes', async () => {
    render(<ConfirmProvider><MobileStockTransferNew onBack={() => {}} /></ConfirmProvider>);
    fireEvent.change(selects()[0]!, { target: { value: 'w1' } });
    fireEvent.change(selects()[1]!, { target: { value: 'w2' } });
    fireEvent.click(screen.getByText('+ Add item'));
    fireEvent.click(screen.getByText('pick CH-1'));
    fireEvent.change(selects()[2]!, { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('Remarks (optional) — shown as Description 2'), {
      target: { value: 'DO-4596 ART0496' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create transfer' }));
    expect((calls[0]! as unknown as { items: Array<{ notes?: string }> }).items[0]!.notes).toBe('DO-4596 ART0496');
  });
});
