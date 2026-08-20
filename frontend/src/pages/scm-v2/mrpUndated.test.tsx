// The MRP page's contract about demand with NO DELIVERY DATE.
//
// This file used to be mrpUndatedBanner.test.tsx and pinned a page-level yellow
// banner that announced how many undated lines/sets were being withheld, with a
// one-click Show them / Hide them. **The owner deleted that banner on 2026-08-20
// (「黄色的也delete掉」), having been told first that it carried DATA rather than
// instruction.** It is his call and it is a deliberate deletion — do not restore
// it as an "accidental removal".
//
// What survives the deletion, and is pinned below:
//
//   • the ROW-level "No date" tag, which is now the ONLY place an undated line
//     announces itself on this page;
//   • the "Show no-date" checkbox in the filter row, which is the only
//     affordance that flips `showUndated` — it is always rendered, so the state
//     is never stranded, and it still drives `includeUndated` on the request;
//   • the default: undated demand stays HIDDEN (owner, 2026-08-18: "这个应该是要
//     把没有日期的藏起来的,不过我点 show no date 它才会出来"). This is the ordering
//     worklist and an undated line is not orderable yet.
//
// What was DELETED with the banner, said plainly rather than quietly dropped:
// the four assertions that read the banner's wording, its Show/Hide button, and
// the sofa-vs-general tally split it rendered. The tally ARITHMETIC those tests
// leaned on is not lost — it is computed and pinned in
// backend/src/scm/routes/mrp.test.ts, which is where it always lived. Nothing on
// this page reads `MrpResponse['undated']` any more, so there is nothing left to
// assert here beyond the fact that it is not rendered.
//
// The hook is mocked at the module seam, the way DailyBank.test.tsx does it.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse } from '../../vendor/scm/lib/mrp-queries';

const EMPTY_TOTALS = {
  skuCount: 0, shortageSkuCount: 0, shortageUnits: 0,
  sofaSetCount: 0, sofaSetShortageCount: 0,
};

const response = (undated: MrpResponse['undated'], skus: MrpResponse['skus'] = []): MrpResponse => ({
  asOf: '2026-08-16T00:00:00Z',
  categories: [], warehouses: [], skus, sofaSets: [],
  undated,
  totals: EMPTY_TOTALS,
});

/* One BEDFRAME sku carrying two order lines competing for the same bucket: one
   promised for December, one with no date at all. Reads the ROW, which is the
   claim that outlived the banner. */
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
/* What the page last ASKED the server for. The checkbox is the only remaining
   way to move this, so a test that only asserted the box looks ticked would not
   have caught the wire being cut. */
let lastIncludeUndated: boolean | undefined;

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: (args: { includeUndated?: boolean }) => {
    lastIncludeUndated = args.includeUndated;
    return { data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} };
  },
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

describe('MRP — undated demand', () => {
  beforeEach(() => {
    mrpData = response({ lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true });
    lastIncludeUndated = undefined;
  });

  /* THE ROW-LEVEL STATEMENT, and since 2026-08-20 the only one. An undated row
     used to render `fmtDate(null)` — the same em-dash as a missing debtor name
     or warehouse, which is not a marking, it is the absence of one. */
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

  /* The owner removed the summary banner (2026-08-20). Pinned as a NEGATIVE so
     a later "restore the count" change is a deliberate decision with a failing
     test in front of it, not a quiet re-add. The payload still carries the
     numbers — that is the point of setting them high here. */
  test('the undated SUMMARY BANNER is gone — the payload carries counts, the page states none', () => {
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 7, sofaShortageUnits: 5, hidden: true });
    renderPage();                                   // opens on Sofa
    expect(screen.queryByText(/sofa sets/)).toBeNull();
    expect(screen.queryByText('7')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Bedframe' }));
    expect(screen.queryByText(/hidden from this view/)).toBeNull();
    expect(screen.queryByText(/listed below, sorted last and marked No date/)).toBeNull();
    expect(screen.queryByText(/order lines/)).toBeNull();
    expect(screen.queryByText('81')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show them' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide them' })).toBeNull();
  });

  /* The banner owned a Show/Hide button. Removing it must not strand
     `showUndated` — the filter-row checkbox is the surviving affordance, and it
     has to reach the REQUEST, not just its own checked state. */
  test('"Show no-date" is the surviving toggle: off by default, and it drives the request', () => {
    mrpData = response({ lines: 81, shortageUnits: 60, sofaSets: 0, sofaShortageUnits: 0, hidden: true });
    renderPage();

    const box = screen.getByLabelText('Show no-date') as HTMLInputElement;
    expect(box.checked).toBe(false);                // hidden by default (2026-08-18)
    expect(lastIncludeUndated).toBe(false);

    fireEvent.click(box);
    expect((screen.getByLabelText('Show no-date') as HTMLInputElement).checked).toBe(true);
    expect(lastIncludeUndated).toBe(true);
  });
});
