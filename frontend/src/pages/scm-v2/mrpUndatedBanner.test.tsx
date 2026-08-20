// The MRP page's contract about what it is NOT showing.
//
// Owner, 2026-08-16: "明明这个东西没有 ready,可是我的 MRP 却 show 不出来." The page
// used to hide demand with no delivery date by default, and hid it in SILENCE,
// so a real shortage rendered as no shortage at all. On production that day the
// default view returned 82 of 163 live 2990 SO-item ids and 8 of 68 short sofa
// sets.
//
// Owner, 2026-08-18, ruling on a build that had flipped the default to shown:
// "这个应该是要把没有日期的藏起来的,不过我点 show no date 它才会出来." Undated demand
// stays HIDDEN by default — this is the ordering worklist and an undated line is
// not orderable — and a forced delivery date is not the answer either, because a
// forced date gets a FAKE one typed into it and a fake date outranks a real one
// in an allocation sorted by date. So the demand keeps its null, stays off the
// list, and STOPS BEING SILENT. The banner therefore has to speak in BOTH
// directions: what is being withheld, or what is on screen. Whichever state the
// page is in, the number is never absent.
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
const response = (undated: MrpResponse['undated'], skus: MrpResponse['skus'] = []): MrpResponse => ({
  asOf: '2026-08-16T00:00:00Z',
  categories: [], warehouses: [], skus, sofaSets: [],
  undated,
  totals: EMPTY_TOTALS,
});

/* One BEDFRAME sku carrying two order lines competing for the same bucket: one
   promised for December, one with no date at all. Used to read the ROW, not the
   banner — the two are different claims and only one of them was pinned. */
const line = (soItemId: string, docNo: string, deliveryDate: string | null): MrpResponse['skus'][number]['lines'][number] => ({
  soItemId, soDocNo: docNo,
  debtorName: 'Beta', customerState: null,
  soDate: '2026-07-01', deliveryDate, processingDate: null, orderByDate: null,
  qty: 5, source: 'shortage', poNumber: null, poEta: null, shortageQty: 5,
  poSupplierId: null, poSupplierName: null,
});

const bedframeSku = (): MrpResponse['skus'] => [{
  warehouseId: null, warehouseCode: null, warehouseName: null,
  itemCode: 'BF-TEST', variantKey: 'BF-TEST', variantLabel: 'Oak',
  description: 'Test bedframe', category: 'BEDFRAME',
  qtyNeeded: 10, stock: 0, poOutstanding: 0, shortage: 10,
  mainSupplierCode: null, mainSupplierName: null, suppliers: [],
  lines: [line('si-dated', 'SO-DATED', '2026-12-01'), line('si-undated', 'SO-UNDATED', null)],
}];

let mrpData: MrpResponse = response({ lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true });

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} }),
  useCategoryLeadTimes: () => ({ data: { leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
  useRegenerateMrp: () => ({ mutate: () => {}, isPending: false }),
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

  /* THE DEFAULT FLIPPED (owner, 2026-08-18) and this is where the old shape of
     the banner would have gone quiet. It used to render only while rows were
     WITHHELD, so the moment "shown" became the default the count vanished from
     the screen — the same silence the banner was built to end, moved one state
     to the left. The count is now unconditional on there BEING undated demand,
     and only its wording depends on which way the flag went. */
  test('toggled on: the count is still on screen, now saying they are listed', () => {
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 0, sofaShortageUnits: 0, hidden: false });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Bedframe' }));

    expect(screen.getByText('81')).toBeTruthy();
    expect(screen.getByText(/order lines/)).toBeTruthy();
    expect(screen.getByText(/listed below, sorted last and marked No date/)).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
    // It must NOT claim they are hidden while it is showing them.
    expect(screen.queryByText(/hidden from this view/)).toBeNull();
    // And the escape hatch points the other way now.
    expect(screen.getByRole('button', { name: 'Hide them' })).toBeTruthy();
  });

  test('the SERVER decides the wording, not the checkbox', () => {
    // The response is what the run DID. A page that trusted its own toggle would
    // keep claiming rows were hidden after asking for them — and, worse, would
    // describe a flag the server never honoured as though it had been.
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 0, sofaShortageUnits: 0, hidden: true });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Bedframe' }));
    // showUndated defaults to true, yet the run came back hidden — the page
    // reports the run.
    expect(screen.getByText(/hidden from this view/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show them' })).toBeTruthy();
  });

  /* The banner is a page-level statement; this is the ROW-level one. Both the
     PR and BUG-HISTORY claim undated rows are "marked No date", and an undated
     row used to render `fmtDate(null)` — the same em-dash as a missing debtor
     name or warehouse, which is not a marking, it is the absence of one. */
  test('an undated ORDER LINE is tagged "No date"; a dated one still shows its date', () => {
    mrpData = response(
      { lines: 1, shortageUnits: 5, sofaSets: 0, sofaShortageUnits: 0, hidden: false },
      bedframeSku(),
    );
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Bedframe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    // Both lines are on screen…
    expect(screen.getByText('SO-DATED')).toBeTruthy();
    expect(screen.getByText('SO-UNDATED')).toBeTruthy();
    // …and only the undated one carries the tag.
    expect(screen.getAllByText('No date')).toHaveLength(1);
    // The dated line keeps a real date rather than being swept into the tag.
    expect(screen.getByText('01/12/2026')).toBeTruthy();
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
