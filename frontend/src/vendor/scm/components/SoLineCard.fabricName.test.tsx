/* DEV-61 (Adrian, 2026-10-08): the phone's fabric picker names the colour
 * ("GD526-16 — Ivory", and "BEETEX Chenille · Ivory" under each hit) while the
 * desktop SO line card showed the bare code only. The desktop picker now shows
 * both, from the same variants.colourLabel the phone reads and the same
 * fabric_library series the pick already stores as fabricLabel. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const HIT = { fabricId: 'GD526', colourId: 'GD526-16', label: 'Ivory', swatchHex: null, sortOrder: 0 };

vi.mock('../lib/mfg-products-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isSuccess: true, isFetching: false }),
  useMaintenanceConfig: () => ({ data: { data: {} } }),
  useSpecialAddons: () => ({ data: [] }),
  useModelAllowedOptionsByCode: () => ({ data: null }),
  useSkuCategoryByCode: () => ({ data: 'FABRIC_ACCESSORY' }),
}));
vi.mock('../lib/fabric-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/fabric-queries')>()),
  useFabricTrackingsLite: () => ({ data: [] }),
  useFabricColoursSearch: () => ({ data: [HIT], isFetching: false }),
}));
vi.mock('../lib/queries', async (orig) => ({
  ...(await orig<typeof import('../lib/queries')>()),
  useFabricLibrary: () => ({ data: [{ id: 'GD526', label: 'BEETEX Chenille' }] }),
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

function renderLine(variants: Record<string, unknown>, onChange = vi.fn()) {
  render(
    <SoLineCard
      index={0}
      draft={{
        itemCode: 'AR01', itemGroup: 'fabric_accessory', description: 'ARM REST 01', uom: 'UNIT',
        qty: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0, remark: '',
        variants,
        lineDeliveryDate: '2026-10-12',
      }}
      onChange={onChange}
      onRemove={() => {}}
      canRemove
      isEditing
      variantsRequired
      seedSofaLegDefault
      attachOptions={null}
    />,
  );
  return onChange;
}

describe('SO line card — the fabric picker names the colour (DEV-61)', () => {
  it('shows the picked code with its colour name', () => {
    renderLine({ fabricCode: 'GD526-16', fabricId: 'GD526', colourLabel: 'Ivory' });
    expect(screen.getByDisplayValue('GD526-16 — Ivory')).toBeTruthy();
  });

  it('shows the bare code when the line has no colour name', () => {
    renderLine({ fabricCode: 'GD526-16', fabricId: 'GD526' });
    expect(screen.getByDisplayValue('GD526-16')).toBeTruthy();
  });

  it('lists series and colour name under each search hit, and the pick stores them', () => {
    const onChange = renderLine({});
    const input = screen.getByPlaceholderText('Type 2+ chars to search…');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'GD' } });
    expect(screen.getByText('BEETEX Chenille · Ivory')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('GD526-16'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      variants: expect.objectContaining({ fabricCode: 'GD526-16', fabricLabel: 'BEETEX Chenille', colourLabel: 'Ivory' }),
    }));
  });
});
