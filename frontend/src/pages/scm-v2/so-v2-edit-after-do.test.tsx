/* DEV-56 (Syasya 2026-10-07, HC-SO-2609-009): a Logistic Admin holding
 * `scm.so.edit_after_do` could not change a delivered order's address — the
 * Override banner lives in the ?edit=1 editor, and this read page greyed out
 * the only way in (Edit / Add line) for anyone without `scm.so.attribute_other`.
 * DEV-32's tests mounted the editor directly, so the door was never tried.
 *
 * Same harness as so-v2-history-and-activity.test.tsx: the real page under a
 * router, only its data hooks faked. The order is HC-SO-2609-009's shape:
 * DELIVERED, every line on one LOADED DO, no invoice.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detail, perms } = vi.hoisted(() => ({ detail: vi.fn(), perms: new Set<string>() }));

vi.mock("../../vendor/scm/lib/sales-order-queries", () => ({
  useMfgSalesOrderDetail: detail,
  useSalesOrderAuditLog: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useSalesOrderRelatedAuditLog: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useSalesOrderPayments: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useUpdateMfgSalesOrderStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useSoLineCoverage: () => ({ data: undefined }),
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: () => "Sheldon Tan" }) }));
vi.mock("../../vendor/scm/lib/admin-queries", () => ({ useStaff: () => ({ data: [], isLoading: false }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../vendor/scm/lib/document-cancel-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/document-cancel-queries")>()),
  useCancelRequest: () => ({ data: undefined }),
  useRaiseCancelRequest: () => ({ mutateAsync: vi.fn() }),
}));
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
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: (k: string) => perms.has(k) }) }));
/* ?edit=1 swaps in the lazy editor; only the URL is under test here. */
vi.mock("./SalesOrderDetail", () => ({ SalesOrderDetail: () => <div data-testid="editor" /> }));

import SalesOrderDetailV2 from "./SalesOrderDetailV2";
import { ADD_LINE_LABEL } from "../../vendor/scm/lib/add-line-handoff";

const DOC = "HC-SO-2609-009";
const DO_OPEN = { id: "do-1", do_number: "HC-DO-2610-015", status: "LOADED", locked: false };

const delivered = {
  doc_no: DOC, status: "DELIVERED", so_date: "2026-09-09", debtor_code: "C1", debtor_name: "Jake Wong",
  customer_type: "EXISTING", currency: "MYR", local_total_sen: 180000, balance_sen: 0, discount_sen: 0,
  phone: "+60176955759", email: null, address1: "Puchong", postcode: "47100",
  has_children: true, downstream_fully_frozen: true, after_do_targets: [DO_OPEN], after_do_invoiced: false,
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

const mount = (so: Record<string, unknown> = delivered) => {
  detail.mockReturnValue({ data: { salesOrder: so, items: [] }, isLoading: false, isPending: false, isError: false, error: null });
  return render(
    <MemoryRouter initialEntries={[`/scm/sales-orders/${DOC}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/scm/sales-orders/:docNo" element={<SalesOrderDetailV2 />} />
      </Routes>
    </MemoryRouter>,
  );
};

const editButtons = () => screen.getAllByRole("button", { name: /^edit$/i }) as HTMLButtonElement[];
const addLine = () => screen.getByRole("button", { name: ADD_LINE_LABEL }) as HTMLButtonElement;

beforeEach(() => perms.clear());
afterEach(() => cleanup());

describe("a delivered order, every line on an open DO", () => {
  it("with Edit SO after DO, Edit and Add line open the editor", () => {
    perms.add("scm.so.edit_after_do");
    mount();
    expect(editButtons().every((b) => !b.disabled)).toBe(true);
    expect(addLine().disabled).toBe(false);
    fireEvent.click(editButtons()[0]);
    expect(screen.getByTestId("loc").textContent).toBe(`/scm/sales-orders/${DOC}?edit=1`);
  });

  it("without it, Edit and Add line stay shut", () => {
    mount();
    expect(editButtons().every((b) => b.disabled)).toBe(true);
    expect(addLine().disabled).toBe(true);
  });

  it("with it, but the order is invoiced, Edit stays shut", () => {
    perms.add("scm.so.edit_after_do");
    mount({ ...delivered, after_do_invoiced: true });
    expect(editButtons().every((b) => b.disabled)).toBe(true);
  });

  it("with it, but the only DO has an invoice or return, Edit stays shut", () => {
    perms.add("scm.so.edit_after_do");
    mount({ ...delivered, after_do_targets: [{ ...DO_OPEN, locked: true }] });
    expect(editButtons().every((b) => b.disabled)).toBe(true);
  });
});
