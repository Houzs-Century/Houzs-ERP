/* A Sofa Accessory line on the Sales Order edit screen, rendered.
 *
 * HC-SO-2609-071 (owner 2026-09-15): five pillow / cushion lines in
 * `fabric_accessory` carried their special order in `variants.extraAddonNote`
 * ("Special Fabric-GD526-16 (BEETEX Chenille)"). The PDF printed it; the edit
 * screen showed no Special Order section at all, and the line's pill read
 * OTHERS. 160 of 268 live Sofa Accessory lines carry such a note (read
 * 2026-09-15), so the text was invisible on most of them.
 *
 * Only the data hooks are faked. The card's own decisions — which category the
 * line resolves to, which panels open, which pill it wears — run for real. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/mfg-products-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isSuccess: true, isFetching: false }),
  useMaintenanceConfig: () => ({ data: undefined }),
  useSpecialAddons: () => ({ data: [] }),
  useModelAllowedOptionsByCode: () => ({ data: null }),
  // What GET /mfg-products/by-code answers for AR01 on production.
  useSkuCategoryByCode: () => ({ data: 'FABRIC_ACCESSORY' }),
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

const NOTE = 'Special Fabric-GD526-16 (BEETEX Chenille)';

function renderArmRest(isEditing: boolean) {
  return render(
    <SoLineCard
      index={3}
      draft={{
        itemCode: 'AR01', itemGroup: 'fabric_accessory', description: 'ARM REST 01', uom: 'UNIT',
        qty: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0, remark: '',
        variants: { fabricCode: 'GD526-16', fabricId: 'GD526', extraAddonNote: NOTE },
        lineDeliveryDate: '2026-10-12',
      }}
      onChange={() => {}}
      onRemove={() => {}}
      canRemove
      docNo="HC-SO-2609-071"
      itemId="line-ar01"
      isEditing={isEditing}
      variantsRequired
      seedSofaLegDefault
    />,
  );
}

describe('SO line card — a Sofa Accessory line', () => {
  it.each([true, false])('shows its Special Order section, counting the note it carries (editing=%s)', (isEditing) => {
    renderArmRest(isEditing);
    expect(screen.getByText('SPECIAL ORDER')).toBeTruthy();
    expect(screen.getByText('(1 selected)')).toBeTruthy();
  });

  it('shows the note itself, open, where it can be read and changed', () => {
    renderArmRest(true);
    // A line that carries a note opens with it (posRemarkSpecialOf), so no click.
    const input = screen.getByDisplayValue(NOTE) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    // And it still folds away like every other Special Orders section.
    fireEvent.click(screen.getByText('Special Orders'));
    expect(screen.queryByDisplayValue(NOTE)).toBeNull();
  });

  it('wears the SOFA ACCESSORY pill, not OTHERS', () => {
    renderArmRest(true);
    expect(screen.getByText('SOFA ACCESSORY')).toBeTruthy();
    expect(screen.queryByText('OTHERS')).toBeNull();
  });
});
