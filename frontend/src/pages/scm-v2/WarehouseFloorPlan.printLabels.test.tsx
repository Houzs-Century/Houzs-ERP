/* Reprinting one damaged rack sticker, or a few (owner 2026-10-02): the slot
   drawer and the batch bar hand the page exactly the labels to print. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Rack } from '../../vendor/scm/lib/warehouse-queries';

vi.mock('../../vendor/scm/lib/warehouse-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/warehouse-queries')>()),
  useMovements: () => ({ data: [], isLoading: false }),
  useUpdateRack: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteRack: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => async () => true }));

const { WarehouseFloorPlan } = await import('./WarehouseFloorPlan');

const rack = (id: string, label: string): Rack => ({
  id, warehouse_id: 'W1', rack: label, position: null, zone: null, status: 'EMPTY',
  reserved: false, notes: null, items: [], created_at: '', updated_at: '',
} as Rack);

const mount = () => {
  const onPrintLabels = vi.fn();
  render(
    <WarehouseFloorPlan
      racks={[rack('R1', 'L3.1'), rack('R2', 'L3.2'), rack('R3', 'L4.1')]}
      warehouseId="W1" isLoading={false} wide view="plan"
      onEditRack={vi.fn()} onStockInHere={vi.fn()} onPrintLabels={onPrintLabels}
    />,
  );
  return onPrintLabels;
};
const slot = (label: string) => screen.getAllByRole('button').find((b) => b.getAttribute('title')?.startsWith(`${label} `))!;

describe('WarehouseFloorPlan — reprint rack stickers', () => {
  it("prints the one rack from its slot drawer", () => {
    const onPrintLabels = mount();
    fireEvent.click(slot('L3.2'));
    fireEvent.click(screen.getByRole('button', { name: /print label/i }));
    expect(onPrintLabels).toHaveBeenCalledWith(['L3.2']);
  });

  it('prints just the selected racks from the batch bar', () => {
    const onPrintLabels = mount();
    fireEvent.click(slot('L3.1'), { ctrlKey: true });
    fireEvent.click(slot('L4.1'), { ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: /print labels/i }));
    expect(onPrintLabels).toHaveBeenCalledWith(['L3.1', 'L4.1']);
  });
});
