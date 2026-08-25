/* SO V2 "History" and "Recent activity" (owner 2026-08-13:
 * "点history的时候没有反应" / "recent activity 加上时间").
 *
 * These are not "does the file import AuditHistoryPanel" assertions. The page
 * is MOUNTED under a real router with only its data hooks faked, and each test
 * asserts what the operator SEES.
 *
 * The two defects were both invisible to a typecheck and to every existing
 * test, which is why they survived: the old handler was
 * `navigate(`…/${docNo}?tab=history`)` — a navigation to the route the user is
 * ALREADY on, carrying a param no Sales Order page reads — and the activity
 * card read `so_date`, a DATE column that cannot carry a time.
 *
 * Both tests were proven to bite by reverting the source (see the PR body).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detail, auditLog, payments, updateStatus } = vi.hoisted(() => ({
  detail: vi.fn(),
  auditLog: vi.fn(),
  payments: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/sales-order-queries", () => ({
  useMfgSalesOrderDetail: detail,
  useSalesOrderAuditLog: auditLog,
  useSalesOrderPayments: payments,
  useUpdateMfgSalesOrderStatus: updateStatus,
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../hooks/useStaffLookup", () => ({
  useStaffLookup: () => ({ nameOf: () => "Kris" }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
/* The 2026-08-25 native-confirm sweep gave the page a useConfirm() (Cancel and
   the unsaved-payments Back gate); like useNotify it throws outside its
   provider, and like useNotify these tests never reach a confirm. */
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("./so-relationship-map", () => ({ useSoRelationshipMap: () => ({ nodes: [], edges: [] }) }));
vi.mock("../../components/scm-v2/PrintPreviewModal", () => ({
  PrintPreviewModal: () => null,
  useOpenPrintPreviewFromUrl: () => undefined,
  usePrintPreview: () => ({ openPreview: vi.fn(), close: vi.fn(), state: null }),
}));
vi.mock("../../components/scm-v2/DocumentRelationshipMapModal", () => ({
  DocumentRelationshipMapModal: () => null,
  DocumentChoiceDialog: () => null,
}));
vi.mock("../../vendor/scm/components/PaymentsTable", () => ({ PaymentsTable: () => null }));
/* The page reads ONE permission (`scm.so.attribute_other`, added 2026-08-17 — it
   decides whether Edit opens on a DO/SI-locked order so its salesperson can be
   changed), and `useAuth` throws outside its provider. Faked as a caller WITHOUT
   it, so these tests keep exercising the behaviour they were written for. */
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => false }) }));

import SalesOrderDetailV2 from "./SalesOrderDetailV2";

afterEach(cleanup);

const DOC = "2990-SO-2608-036";

const header = {
  doc_no: DOC,
  status: "confirmed",
  so_date: "2026-08-14",
  debtor_code: "C1",
  debtor_name: "Ada",
  customer_type: "retail",
  currency: "MYR",
  local_total_sen: 100000,
  balance_sen: 0,
  discount_sen: 0,
  phone: null,
  email: null,
};

/* One audit row, recorded at a time of day that `so_date` provably cannot
   carry — that is the whole point of the second test. */
const auditEntry = {
  id: "a1",
  action: "UPDATE_STATUS",
  created_at: "2026-08-14T09:53:00.000Z",
  actor_name_snapshot: "Kris",
  changes: null,
};

const loaded = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null });

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

const mountPage = () => {
  detail.mockReturnValue(loaded({ salesOrder: header, items: [] }));
  payments.mockReturnValue(loaded([]));
  updateStatus.mockReturnValue({ mutate: vi.fn(), isPending: false });
  return render(
    <MemoryRouter initialEntries={[`/scm/sales-orders/${DOC}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/scm/sales-orders/:docNo" element={<SalesOrderDetailV2 />} />
      </Routes>
    </MemoryRouter>
  );
};

describe("SO V2 History button", () => {
  it("opens the audit drawer in place, without navigating", () => {
    auditLog.mockReturnValue(loaded([auditEntry]));
    mountPage();

    const urlBefore = screen.getByTestId("loc").textContent;
    expect(screen.queryByRole("dialog", { name: /sales order history/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));

    /* The drawer is on screen ... */
    expect(screen.getByRole("dialog", { name: /sales order history/i })).toBeTruthy();
    expect(screen.getByText(new RegExp(`History · ${DOC}`))).toBeTruthy();
    /* ... and we did NOT navigate to do it. The old code's only effect was to
       push the URL we were already on, which is why nothing happened. */
    expect(screen.getByTestId("loc").textContent).toBe(urlBefore);
  });
});

describe("SO V2 Recent activity", () => {
  it("shows the audit entry's time of day, not the date-only so_date", () => {
    auditLog.mockReturnValue(loaded([auditEntry]));
    mountPage();

    /* A real clock time. `so_date` is "2026-08-14" — a DATE column — so no
       formatting of it could ever produce h:mm. The hour is `numeric` and the
       suite's timezone is not pinned, so match 1-or-2 digits rather than
       asserting a wall-clock hour this test does not control. */
    expect(screen.getByText(/Status changed/)).toBeTruthy();
    expect(screen.getAllByText(/\d{1,2}:\d{2}/).length).toBeGreaterThan(0);
  });

  it("falls back to the synthesized rows when the order has no audit entries", () => {
    auditLog.mockReturnValue(loaded([]));
    mountPage();

    /* Losing the card entirely is a worse answer than a dateless one. */
    expect(screen.getByText(/^Created$/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /sales order history/i })).toBeNull();
  });
});
