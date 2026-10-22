import { describe, it, expect } from 'vitest';
import { withMasterPickerPools } from './picker-maint';
import type { MaintenanceConfig } from './mfg-products-queries';

/* The production shapes from BUG-60 (2990's Home, read 2026-10-06): HOOKKA
   INDUSTRIES' supplier overlay saved 2026-05-29, and master after DEFAULT was
   added on 2026-10-05. */
const HOOKKA = {
  sofaSizes: ['24', '26', '28', '30', '32', '35'],
  sofaLegHeights: [
    { value: 'No Leg', priceSen: 0 },
    { value: '4"', priceSen: 3000 },
    { value: '6"', priceSen: 4000 },
    { value: '1"', priceSen: 0 },
  ],
  gaps: [], divanHeights: [], legHeights: [],
} as unknown as MaintenanceConfig;

const MASTER = {
  sofaSizes: ['24', '26', '28', '30', '32', '35', '37', 'Flat', 'DEFAULT'],
  sofaLegHeights: [
    { value: 'No Leg', priceSen: 0 },
    { value: '4"', priceSen: 5000 },
    { value: '6"', priceSen: 6000 },
    { value: '1"', priceSen: 0 },
    { value: 'Iron Metal Leg', priceSen: 0, active: false },
    { value: '2"', priceSen: 0 },
    { value: '6.5”', priceSen: 0 },
    { value: 'DEFAULT', priceSen: 0 },
  ],
  gaps: [], divanHeights: [], legHeights: [],
} as unknown as MaintenanceConfig;

const values = (pool: unknown): string[] =>
  (pool as Array<string | { value: string }>).map((e) => (typeof e === 'string' ? e : e.value));

describe('withMasterPickerPools (BUG-60)', () => {
  it('offers master DEFAULT for seat size and leg height on a supplier with an older overlay', () => {
    const out = withMasterPickerPools(HOOKKA, MASTER)!;
    expect(values(out.sofaSizes)).toContain('DEFAULT');
    expect(values(out.sofaLegHeights)).toContain('DEFAULT');
    expect(values(out.sofaSizes)).toEqual(values(MASTER.sofaSizes));
  });

  it('keeps master active flags, so an option master switched off stays off', () => {
    const out = withMasterPickerPools(HOOKKA, MASTER)!;
    const iron = (out.sofaLegHeights as Array<{ value: string; active?: boolean }>).find((o) => o.value === 'Iron Metal Leg');
    expect(iron?.active).toBe(false);
  });

  it('keeps a value only the supplier overlay lists, matching inch marks by glyph', () => {
    const supplier = {
      ...HOOKKA,
      sofaLegHeights: [...(HOOKKA.sofaLegHeights as object[]), { value: '6.5"', priceSen: 0 }, { value: 'Supplier Only', priceSen: 100 }],
    } as unknown as MaintenanceConfig;
    const out = values(withMasterPickerPools(supplier, MASTER)!.sofaLegHeights);
    expect(out.filter((v) => v.startsWith('6.5'))).toEqual(['6.5”']);
    expect(out).toContain('Supplier Only');
  });

  it('leaves the overlay prices untouched for cost lookups', () => {
    withMasterPickerPools(HOOKKA, MASTER);
    expect(values(HOOKKA.sofaSizes)).toEqual(['24', '26', '28', '30', '32', '35']);
    expect((HOOKKA.sofaLegHeights as Array<{ priceSen: number }>)[1].priceSen).toBe(3000);
  });

  it('falls back to whichever config is loaded', () => {
    expect(withMasterPickerPools(null, MASTER)).toBe(MASTER);
    expect(withMasterPickerPools(HOOKKA, null)).toBe(HOOKKA);
    expect(withMasterPickerPools(MASTER, MASTER)).toBe(MASTER);
    expect(withMasterPickerPools(null, null)).toBeNull();
  });
});
