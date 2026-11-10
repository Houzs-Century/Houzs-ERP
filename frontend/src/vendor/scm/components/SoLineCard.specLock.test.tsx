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

type OnChange = Parameters<typeof SoLineCard>[0]['onChange'];

function lineProps(specLockedReason: string | null, variants: Record<string, unknown>, onChange: ReturnType<typeof vi.fn<OnChange>>) {
  return {
    index: 0,
    draft: {
      itemCode: 'CODY-(K)', itemGroup: 'bedframe', description: 'CODY King', uom: 'UNIT',
      qty: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0, remark: '',
      variants, lineDeliveryDate: '2026-11-10',
    },
    onChange,
    onRemove: () => {},
    canRemove: true,
    isEditing: true,
    variantsRequired: false,
    specLockedReason,
    lineDateLocked: false,
    seedSofaLegDefault: false,
    attachOptions: null,
  };
}

function renderLine(specLockedReason: string | null) {
  const onChange = vi.fn<OnChange>();
  const view = render(<SoLineCard {...lineProps(specLockedReason, { ...SHIPPED }, onChange)} />);
  return Object.assign(onChange, { view });
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

  /* PR #5609 follow-up: opening a saved line writes nothing, locked or not. The
     total is derived and no longer part of the stock key, but the line stays as
     it was saved until somebody changes a part. */
  it('unlocked, opening a saved line does not write Total Height', () => {
    const onChange = renderLine(null);
    expect(screen.queryByRole('note')).toBeNull();
    expect(totalHeightWrites(onChange)).toEqual([]);
  });

  it('unlocked, changing a part writes the new Total Height', () => {
    const onChange = renderLine(null);
    onChange.view.rerender(<SoLineCard {...lineProps(null, { ...SHIPPED, legHeight: '6"' }, onChange)} />);
    const writes = totalHeightWrites(onChange);
    expect(writes.length).toBeGreaterThan(0);
    expect((writes.at(-1)![0] as { variants: { totalHeight: string } }).variants.totalHeight).toBe('26"');
  });
});
