// What the Seed Racks modal SENDS.
//
// The label shapes themselves are pinned on both sides of the vendored pair
// (backend/src/scm/shared/rack-labels.test.ts and
// vendor/shared/rack-labels.canonical.test.ts). Neither of those can see the
// wire: a modal that computes a perfect preview and then posts the old flat
// body would pass all of them and still create "Rack 1".."Rack 21". This test
// reads the body the page hands the mutation, which is the only place that
// claim is checkable.
//
// The hooks are mocked at the module seam, the way mrpUndated.test.tsx does it.
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const WAREHOUSE_ID = 'wh-kl';

let lastBody: Record<string, unknown> | null = null;

vi.mock('../../vendor/scm/lib/warehouse-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/warehouse-queries')>()),
  useRacks: () => ({
    data: {
      racks: [],
      warehouses: [{ id: WAREHOUSE_ID, code: 'KL WAREHOUSE', name: 'KL WAREHOUSE' }],
      summary: { total: 0, occupied: 0, empty: 0, reserved: 0, occupancyRate: 0 },
    },
    isLoading: false, isError: false, error: null,
  }),
  useCreateRack: () => ({
    mutate: (body: Record<string, unknown>) => { lastBody = body; },
    isPending: false,
  }),
  useUpdateRack: () => ({ mutate: () => {}, isPending: false }),
  useDeleteRack: () => ({ mutateAsync: async () => {}, isPending: false }),
  useStockIn: () => ({ mutate: () => {}, isPending: false }),
  useStockOut: () => ({ mutate: () => {}, isPending: false }),
  useMovements: () => ({ data: { movements: [] }, isLoading: false, isError: false }),
}));

vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({
    data: [{ id: WAREHOUSE_ID, code: 'KL WAREHOUSE', name: 'KL WAREHOUSE' }],
    isLoading: false,
  }),
}));

vi.mock('../../vendor/scm/components/NotifyDialog', () => ({
  useNotify: () => () => {},
  NotifyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({
  useConfirm: () => async () => true,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { WarehouseRacks } = await import('./WarehouseRacks');

const openSeedModal = () => {
  render(
    <MemoryRouter initialEntries={[`/scm/warehouse?warehouseId=${WAREHOUSE_ID}`]}>
      <WarehouseRacks />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /seed racks/i }));
};

const setField = (label: RegExp, value: string) => {
  const input = screen.getByText(label).parentElement!.querySelector('input')!;
  fireEvent.change(input, { target: { value } });
};

describe('Seed Racks — the body the page posts', () => {
  beforeEach(() => { lastBody = null; });

  test("the owner's L-series run posts series and levels, and previews the real labels", () => {
    openSeedModal();
    setField(/^Series/, 'L');
    setField(/^How many/, '21');
    setField(/^Levels per aisle$/, '2');

    // The preview names the FIRST and LAST label, from the shared generator.
    expect(screen.getByText(/Creates 42 racks/)).toBeTruthy();
    expect(screen.getByText('Rack L1.1')).toBeTruthy();
    expect(screen.getByText('Rack L21.2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /create racks/i }));

    expect(lastBody).toMatchObject({
      warehouseId: WAREHOUSE_ID, prefix: 'Rack', series: 'L', count: 21, levels: 2,
    });
  });

  test('the R-series run is the same wire with 17 aisles', () => {
    openSeedModal();
    setField(/^Series/, 'R');
    setField(/^How many/, '17');
    setField(/^Levels per aisle$/, '2');
    fireEvent.click(screen.getByRole('button', { name: /create racks/i }));

    expect(lastBody).toMatchObject({ series: 'R', count: 17, levels: 2 });
  });

  test('untouched, it still posts the flat shape it always did', () => {
    openSeedModal();
    fireEvent.click(screen.getByRole('button', { name: /create racks/i }));

    expect(lastBody).toMatchObject({ prefix: 'Rack', count: 10, levels: 1, series: '' });
  });
});
