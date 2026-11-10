/* Owner 2026-11-10: a shipped DO line keeps its product and spec. On
 * 2990-DO-2611-016 the edit form computed Total Height (8 + 4 + 12 = 24) on open,
 * the save sent it, and the line moved into a stock bucket nothing carries. With
 * specLockedReason set the card shows why, disables the spec, and writes nothing
 * on its own; qty stays editable. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DO_SPEC_LOCKED_MESSAGE } from '../../shared/do-spec-lock';

/* The active company decides the mode (lib/binding-mode.ts): company 1 binds by
   PO and keeps today's behaviour; company 2 tracks stock by variant. */
const world = vi.hoisted(() => ({ companyId: 2 as number | null, category: 'BEDFRAME', maint: {} as Record<string, unknown> }));
vi.mock('../../../lib/activeCompany', async (orig) => ({
  ...(await orig<typeof import('../../../lib/activeCompany')>()),
  getActiveCompanyId: () => world.companyId,
}));
vi.mock('../lib/mfg-products-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isSuccess: true, isFetching: false }),
  useMaintenanceConfig: () => ({ data: { data: world.maint } }),
  useSpecialAddons: () => ({ data: [] }),
  useModelAllowedOptionsByCode: () => ({ data: null }),
  useSkuCategoryByCode: () => ({ data: world.category }),
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

  /* PR #5609 follow-up, company 2 (variant-tracked): opening a saved line writes
     nothing; the line stays as it was saved until somebody changes a part. */
  it('company 2, unlocked: opening a saved line does not write Total Height', () => {
    world.companyId = 2;
    const onChange = renderLine(null);
    expect(screen.queryByRole('note')).toBeNull();
    expect(totalHeightWrites(onChange)).toEqual([]);
  });

  it('company 2, unlocked: changing a part writes the new Total Height', () => {
    world.companyId = 2;
    const onChange = renderLine(null);
    onChange.view.rerender(<SoLineCard {...lineProps(null, { ...SHIPPED, legHeight: '6"' }, onChange)} />);
    const writes = totalHeightWrites(onChange);
    expect(writes.length).toBeGreaterThan(0);
    expect((writes.at(-1)![0] as { variants: { totalHeight: string } }).variants.totalHeight).toBe('26"');
  });
});

/* Company 1 (Houzs Century, PO hard binding) keeps today's behaviour exactly. */
describe('SoLineCard - company 1 is unchanged', () => {
  it('opening a saved bedframe line still fills in Total Height (8 + 4 + 12 = 24)', () => {
    world.companyId = 1; world.category = 'BEDFRAME'; world.maint = {};
    const onChange = renderLine(null);
    const writes = totalHeightWrites(onChange);
    expect(writes.length).toBeGreaterThan(0);
    expect((writes.at(-1)![0] as { variants: { totalHeight: string } }).variants.totalHeight).toBe('24"');
  });

  it('opening a saved sofa line with no leg still seeds the "Default" leg; company 2 does not', () => {
    const legWrites = (onChange: ReturnType<typeof vi.fn<OnChange>>) =>
      onChange.mock.calls.filter(([p]) => (p.variants as Record<string, unknown> | undefined)?.legHeight === 'Default');
    const open = (companyId: number) => {
      world.companyId = companyId; world.category = 'SOFA'; world.maint = { sofaLegHeights: ['Default', '6"'] };
      const onChange = vi.fn<OnChange>();
      const props = lineProps(null, { fabricCode: 'BO315-23', seatHeight: '35' }, onChange);
      render(<SoLineCard {...props} draft={{ ...props.draft, itemCode: '8030-2A(LHF)', itemGroup: 'sofa' }} seedSofaLegDefault />);
      return onChange;
    };
    expect(legWrites(open(1)).length).toBeGreaterThan(0);
    expect(legWrites(open(2))).toEqual([]);
    world.category = 'BEDFRAME'; world.maint = {};
  });
});
