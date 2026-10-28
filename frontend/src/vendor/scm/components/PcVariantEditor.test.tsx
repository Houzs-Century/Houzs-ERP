/**
 * PcVariantEditor — the consignment family's variant editor now renders the ONE
 * shared SpecialOrders block (owner 2026-07-20 unification). These pin the
 * consignment-specific wiring: the SpecialOrders patch is fanned out onto the
 * line's variant bag through the per-key `onChange`, writing the canonical
 * `variants.specials` ARRAY (never the legacy singular key), showing the human
 * label, and — on a parent-linked line — carrying the parent's special order
 * read-only until Override.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MaintenanceConfig } from '../lib/mfg-products-queries';

// Mock the two react-query hooks PcVariantEditor calls at runtime. The addon is
// defined INSIDE the factory (vi.mock is hoisted above the imports, so it can't
// close over a top-level const).
vi.mock('../lib/mfg-products-queries', () => {
  const HB = {
    id: 'HB_FULL', code: 'HB_FULL', label: 'HB Fully Cover', soDescription: 'HB Fully Cover',
    categories: ['BEDFRAME'], sellingPriceSen: 0, costPriceSen: 0, optionGroups: [], active: true, sortOrder: 0,
  };
  return {
    useSpecialAddons: () => ({ data: [HB] }),
    useModelAllowedOptionsByCode: () => ({ data: null }),
  };
});

import { PcVariantEditor } from './PcVariantEditor';
import { withMasterPickerPools } from '../lib/picker-maint';

// Minimal maintenance config — the bedframe branch only reads the (empty) option
// pools; the specials pool comes from the mocked useSpecialAddons.
const MAINT = { gaps: [], divanHeights: [], legHeights: [], sofaSizes: [], sofaLegHeights: [] } as unknown as MaintenanceConfig;

afterEach(cleanup);

const openBlock = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /Special Orders/i }));

describe('PcVariantEditor — unified Special Orders (consignment)', () => {
  it('shows the human label, not the raw code', () => {
    render(<PcVariantEditor category="bedframe" variants={{ specials: ['HB_FULL'] }} onChange={() => {}} fabrics={[]} maint={MAINT} />);
    expect(screen.getByText('HB Fully Cover')).toBeTruthy();
    expect(screen.queryByText('HB_FULL')).toBeNull();
  });

  it('reads variants.specials (array) back as a checked pick', () => {
    render(<PcVariantEditor category="bedframe" variants={{ specials: ['HB_FULL'] }} onChange={() => {}} fabrics={[]} maint={MAINT} />);
    expect((screen.getByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('writes the canonical variants.specials ARRAY on toggle, never the singular key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PcVariantEditor category="bedframe" variants={{}} onChange={onChange} fabrics={[]} maint={MAINT} />);
    await openBlock(user);
    await user.click(screen.getByRole('checkbox', { name: /HB Fully Cover/i }));
    expect(onChange).toHaveBeenCalledWith('specials', ['HB_FULL']);
    expect(onChange).toHaveBeenCalledWith('specialLabels', ['HB Fully Cover']);
    expect(onChange).not.toHaveBeenCalledWith('special', expect.anything());
  });

  it('carries the Custom / other free text through onChange.extraAddonNote', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PcVariantEditor category="bedframe" variants={{}} onChange={onChange} fabrics={[]} maint={MAINT} />);
    await openBlock(user);
    await user.click(screen.getByRole('button', { name: /Custom \/ other/i }));
    await user.type(screen.getByPlaceholderText(/Describe the special order/i), 'X');
    expect(onChange).toHaveBeenCalledWith('extraAddonNote', 'X');
  });

  it('source-linked line is read-only until Override (carry-through, not re-entry)', async () => {
    const user = userEvent.setup();
    render(
      <PcVariantEditor
        category="bedframe"
        variants={{ specials: ['HB_FULL'] }}
        onChange={() => {}}
        fabrics={[]}
        maint={MAINT}
        sourceLinked
        sourceLabel="Purchase Consignment Order"
      />,
    );
    expect((screen.getByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /Override/i }));
    expect((screen.getByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe('PcVariantEditor — sofa pickers follow master (BUG-60)', () => {
  // 2990's Home: HOOKKA INDUSTRIES' 2026-05-29 overlay vs master after DEFAULT was added.
  const HOOKKA = {
    gaps: [], divanHeights: [], legHeights: [],
    sofaSizes: ['24', '26', '28', '30', '32', '35'],
    sofaLegHeights: [{ value: 'No Leg', priceSen: 0 }, { value: '4"', priceSen: 3000 }],
  } as unknown as MaintenanceConfig;
  const MASTER = {
    gaps: [], divanHeights: [], legHeights: [],
    sofaSizes: ['24', '26', '28', '30', '32', '35', '37', 'Flat', 'DEFAULT'],
    sofaLegHeights: [{ value: 'No Leg', priceSen: 0 }, { value: '4"', priceSen: 5000 }, { value: 'DEFAULT', priceSen: 0 }],
  } as unknown as MaintenanceConfig;
  const optionValues = (label: string) =>
    Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);

  it('the supplier overlay alone hides DEFAULT (the reported screen)', () => {
    render(<PcVariantEditor category="sofa" variants={{}} onChange={() => {}} fabrics={[]} maint={HOOKKA} />);
    expect(optionValues('Seat Size')).not.toContain('DEFAULT');
  });

  it('offers and writes DEFAULT for Seat Size and Leg Heights', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PcVariantEditor category="sofa" variants={{}} onChange={onChange} fabrics={[]} maint={withMasterPickerPools(HOOKKA, MASTER)!} />);
    expect(optionValues('Seat Size')).toContain('DEFAULT');
    expect(optionValues('Leg Heights')).toContain('DEFAULT');
    await user.selectOptions(screen.getByLabelText('Seat Size'), 'DEFAULT');
    await user.selectOptions(screen.getByLabelText('Leg Heights'), 'DEFAULT');
    expect(onChange).toHaveBeenCalledWith('seatHeight', 'DEFAULT');
    expect(onChange).toHaveBeenCalledWith('legHeight', 'DEFAULT');
  });
});
