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

const { detail, auditLog, relatedAuditLog, payments, updateStatus } = vi.hoisted(() => ({
  detail: vi.fn(),
  auditLog: vi.fn(),
  relatedAuditLog: vi.fn(),
  payments: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/sales-order-queries", () => ({
  useMfgSalesOrderDetail: detail,
  useSalesOrderAuditLog: auditLog,
  useSalesOrderRelatedAuditLog: relatedAuditLog,
  useSalesOrderPayments: payments,
  useUpdateMfgSalesOrderStatus: updateStatus,
  useDeleteMfgSalesOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSoLineCoverage: () => ({ data: undefined }),
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../hooks/useStaffLookup", () => ({
  useStaffLookup: () => ({ nameOf: () => "Kris" }),
}));
vi.mock("../../vendor/scm/lib/admin-queries", () => ({
  useStaff: () => ({
    data: [
      { id: "s-1", name: "Stanley" },
      { id: "s-2", name: "alicia" },
    ],
    isLoading: false,
  }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../vendor/scm/lib/document-cancel-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/document-cancel-queries")>()),
  useCancelRequest: () => ({ data: undefined }),
  useRaiseCancelRequest: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../components/scm-v2/DeliveryIssuesCard", () => ({ SoDeliveryIssuesCard: () => null }));
vi.mock("../../vendor/scm/components/CancelRequestPanel", () => ({ CancelRequestPanel: () => null }));
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
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => false }) }));

import SalesOrderDetailV2 from "./SalesOrderDetailV2";

afterEach(() => {
  cleanup();
  relatedAuditLog.mockReset();
});

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

const mountPage = (so: Record<string, unknown> = header) => {
  detail.mockReturnValue(loaded({ salesOrder: so, items: [] }));
  payments.mockReturnValue(loaded([]));
  if (!relatedAuditLog.getMockImplementation()) relatedAuditLog.mockReturnValue(loaded([]));
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

    expect(screen.getByRole("dialog", { name: /sales order history/i })).toBeTruthy();
    expect(screen.getByText(new RegExp(`History · ${DOC}`))).toBeTruthy();
    expect(screen.getByTestId("loc").textContent).toBe(urlBefore);
  });
});

describe("SO V2 History related documents", () => {
  it("shows the PO raised from the order, in time order, linked to the PO", () => {
    auditLog.mockReturnValue(loaded([auditEntry]));
    relatedAuditLog.mockReturnValue(loaded([{
      id: 7,
      entity_type: "PURCHASE_ORDER",
      entity_id: "po-uuid-1",
      entity_doc_no: "HC-PO-2608-012",
      action: "CREATE",
      actor_id: null,
      actor_name_snapshot: "Wei Pin",
      field_changes: [],
      status_snapshot: "DRAFT",
      source: "web",
      note: null,
      created_at: "2026-08-14T10:30:00.000Z",
    }]));
    mountPage();

    expect(relatedAuditLog).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    expect(relatedAuditLog).toHaveBeenLastCalledWith(DOC);

    const dialog = screen.getByRole("dialog", { name: /sales order history/i });
    expect(dialog.textContent).toMatch(/\(2\)/);
    const created = screen.getByText("Created purchase order");
    const link = screen.getByRole("link", { name: "HC-PO-2608-012" });
    expect(link.getAttribute("href")).toBe("/scm/purchase-orders/po-uuid-1");
    const status = screen.getAllByText("Status changed").find((el) => dialog.contains(el))!;
    expect(created.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("SO V2 Recent activity", () => {
  it("shows the audit entry's time of day, not the date-only so_date", () => {
    auditLog.mockReturnValue(loaded([auditEntry]));
    mountPage();

    expect(screen.getByText(/Status changed/)).toBeTruthy();
    expect(screen.getAllByText(/\d{1,2}:\d{2}/).length).toBeGreaterThan(0);
  });

  it("falls back to the synthesized rows when the order has no audit entries", () => {
    auditLog.mockReturnValue(loaded([]));
    mountPage();

    expect(screen.getByText(/^Created$/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /sales order history/i })).toBeNull();
  });
});

/* "Shared with" (owner 2026-09-09: "SO 详情页也要能看到共享给了谁"). An order can
   be shared with several salespeople, and until this shipped the grants were
   visible only on the maintenance panel and in the audit log — state a user
   cannot see is state they cannot correct. */
describe("SO V2 shared-with", () => {
  it("names the people the order is shared with, never their uuids", () => {
    auditLog.mockReturnValue(loaded([]));
    mountPage({ ...header, collaborator_staff_ids: ["s-1", "s-2"] });

    expect(screen.getByText("Shared with")).toBeTruthy();
    expect(screen.getByText("alicia, Stanley")).toBeTruthy();
    expect(screen.queryByText(/s-1/)).toBeNull();
  });

  it("renders no field at all when the order is shared with nobody", () => {
    auditLog.mockReturnValue(loaded([]));
    mountPage({ ...header, collaborator_staff_ids: [] });
    expect(screen.queryByText("Shared with")).toBeNull();
  });
});
