// The MRP page's contract about what it is NOT showing.
//
// Owner, 2026-08-16: "明明这个东西没有 ready,可是我的 MRP 却 show 不出来." The page
// hides demand with no delivery date by default — deliberate, and unchanged —
// but it hid it in SILENCE, so a real shortage rendered as no shortage at all.
// On production that day the default view returned 82 of 163 live 2990 SO-item
// ids and 8 of 68 short sofa sets.
//
// What is pinned here is the visibility, not the arithmetic: the count itself is
// computed and tested in backend/src/scm/routes/mrp.test.ts. The hook is mocked
// at the module seam, the way DailyBank.test.tsx does it.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse } from '../../vendor/scm/lib/mrp-queries';

const EMPTY_TOTALS = {
  skuCount: 0, shortageSkuCount: 0, shortageUnits: 0,
  sofaSetCount: 0, sofaSetShortageCount: 0,
};

/* The general (non-sofa) tabs read `lines`; the sofa tab reads `sofaSets`.
   Both are populated here on purpose so a test that reads the WRONG one — the
   bug this split exists to prevent — shows up as the wrong number on screen
   rather than as a passing assertion. */
const response = (undated: MrpResponse['undated']): MrpResponse => ({
  asOf: '2026-08-16T00:00:00Z',
  categories: [], warehouses: [], skus: [], sofaSets: [],
  undated,
  totals: EMPTY_TOTALS,
});

let mrpData: MrpResponse = response({ lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true });

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} }),
  useCategoryLeadTimes: () => ({ data: { leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  isAdminLevel: () => true,
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useCreatePosFromSoItems: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
}));

import { Mrp } from './Mrp';

const renderPage = () => render(<MemoryRouter><Mrp /></MemoryRouter>);

describe('MRP — hidden undated demand is stated on the page', () => {
  beforeEach(() => {
    mrpData = response({ lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true });
  });

  test('the count and its shortage are on screen, with a way to show them', () => {
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 0, sofaShortageUnits: 0, hidden: true });
    renderPage();
    // The page opens on the Sofa tab; move to a general tab to read `lines`.
    fireEvent.click(screen.getByRole('tab', { name: 'Bedframe' }));

    expect(screen.getByText('81')).toBeTruthy();
    expect(screen.getByText(/order lines/)).toBeTruthy();
    expect(screen.getByText(/hidden from this view/)).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();               // the alarming half
    expect(screen.getByText(/units are.*short/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show them' })).toBeTruthy();
  });

  test('nothing hidden → no banner (it must not become page furniture)', () => {
    mrpData = response({ lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true });
    renderPage();
    expect(screen.queryByText(/hidden from this view/)).toBeNull();
  });

  test('the SERVER decides "hidden", not the checkbox: hidden=false shows no banner', () => {
    // The response is what the run DID. A page that trusted its own toggle would
    // keep claiming rows were hidden after asking for them — and, worse, would
    // stay silent for a caller whose flag the server never honoured.
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 0, sofaShortageUnits: 0, hidden: false });
    renderPage();
    expect(screen.queryByText(/hidden from this view/)).toBeNull();
  });

  test('the sofa tab reads the SOFA tally, not the general one', () => {
    // Blending the two would report the whole sofa book on every other tab and
    // the wrong number here: section 8 ignores the category filter, section 7
    // honours it.
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 7, sofaShortageUnits: 5, hidden: true });
    renderPage();                                   // opens on Sofa
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/sofa sets/)).toBeTruthy();
    expect(screen.queryByText('81')).toBeNull();
  });
});
