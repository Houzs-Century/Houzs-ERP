// The frontend half of the company switch (backend lib/binding-mode.ts): company
// 1 binds lines to their PO and keeps today's line-card behaviour exactly.
import { describe, expect, test, vi } from 'vitest';

const active = vi.hoisted(() => ({ id: null as number | null }));
vi.mock('../../../lib/activeCompany', () => ({ getActiveCompanyId: () => active.id }));

const { HARD_BOUND_COMPANY_ID, activeCompanyTracksVariants, variantTrackedCompany } = await import('./binding-mode');

describe('binding-mode', () => {
  test('company 1 and an unresolved company keep the legacy behaviour; company 2 tracks variants', () => {
    expect(HARD_BOUND_COMPANY_ID).toBe(1);
    expect(variantTrackedCompany(1)).toBe(false);
    expect(variantTrackedCompany(null)).toBe(false);
    expect(variantTrackedCompany(2)).toBe(true);
  });

  test('reads the active company', () => {
    active.id = 1; expect(activeCompanyTracksVariants()).toBe(false);
    active.id = 2; expect(activeCompanyTracksVariants()).toBe(true);
    active.id = null; expect(activeCompanyTracksVariants()).toBe(false);
  });
});
