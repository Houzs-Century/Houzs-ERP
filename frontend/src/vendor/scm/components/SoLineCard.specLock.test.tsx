/* Owner 2026-11-10: a shipped DO line keeps its product and spec. On
 * 2990-DO-2611-016 the edit form computed Total Height (8 + 4 + 12 = 24) on open,
 * the save sent it, and the line moved into a stock bucket nothing carries. With
 * specLockedReason set the card shows why, disables the spec, and writes nothing
 * on its own; qty stays editable. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DO_SPEC_LOCKED_MESSAGE } from '../../shared/do-spec-lock';

vi.mock('../lib/mfg-products-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isSuccess: true, isFetching: false }),
  useMaintenanceConfig: () => ({ data: { data: {} } }),
  useSpecialAddons: () => ({ data: [] }),
  useModelAllowedOptionsByCode: () => ({ data: null }),
  useSkuCategoryByCode: () => ({ data: 'BEDFRAME' }),
}));
vi.mock('../lib/fabric-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/fabric-queries')>()),
  useFabricTrackingsLite: () => ({ data: [] }),
  useFabricColoursSearch: () => ({ data: [], isFetching: false }),
}));
vi.mock('../lib/queries', async (orig) => ({
  ...(await orig<typeof import('../lib/queries')>()),
  useFabricLibrary: () => ({ data: [] }),
}));
vi.mock('../lib/sales-order-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/sales-order-queries')>()),
  useUploadSoItemPhoto: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSoItemPhoto: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../lib/auth', async (orig) => ({
  ...(await orig<typeof import('../lib/auth')>()),
  useAuth: () => ({ staff: { id: 1, role: 'admin' } }),
}));
vi.mock('./NotifyDialog', () => ({ useNotify: () => vi.fn() }));

const { SoLineCard } = await import('./SoLineCard');

const SHIPPED = { fabricCode: 'BF-01', gap: '12"', divanHeight: '8"', legHeight: '4"' };

function renderLine(specLockedReason: string | null) {
  const onChange = vi.fn();
  render(
    <SoLineCard
      index={0}
      draft={{
        itemCode: 'CODY-(K)', itemGroup: 'bedframe', description: 'CODY King', uom: 'UNIT',
        qty: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0, remark: '',
        variants: { ...SHIPPED }, lineDeliveryDate: '2026-11-10',
      }}
      onChange={onChange}
      onRemove={() => {}}
      canRemove
      isEditing
      variantsRequired={false}
      specLockedReason={specLockedReason}
      lineDateLocked={false}
      seedSofaLegDefault={false}
      attachOptions={null}
    />,
  );
  return onChange;
}

const totalHeightWrites = (onChange: ReturnType<typeof vi.fn>) =>
  onChange.mock.calls.filter(([p]) => p?.variants && 'totalHeight' in (p.variants as object));

describe('SoLineCard — spec locked on a shipped DO line', () => {
  it('says why, and does not compute Total Height into the line', () => {
    const onChange = renderLine(DO_SPEC_LOCKED_MESSAGE);
    expect(screen.getByRole('note').textContent).toBe(DO_SPEC_LOCKED_MESSAGE);
    expect(totalHeightWrites(onChange)).toEqual([]);
  });

  it('disables the variant pickers but leaves qty editable', () => {
    renderLine(DO_SPEC_LOCKED_MESSAGE);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((s) => s.disabled)).toBe(true);
    const qty = screen.getByDisplayValue('1') as HTMLInputElement;
    expect(qty.disabled).toBe(false);
  });

  it('unlocked (a draft, or a new line) the card behaves as before: Total Height is filled in', () => {
    const onChange = renderLine(null);
    expect(screen.queryByRole('note')).toBeNull();
    expect(totalHeightWrites(onChange).length).toBeGreaterThan(0);
  });
});
