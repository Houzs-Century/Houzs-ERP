/* BUG-101 (Sim, 2026-10-10): bringing a Delivery Date forward on an order that
 * already has a Purchase Order needs the Purchaser AND Logistic. The Logistic
 * amendment shows a Purchaser OK step; Logistic's approve waits for it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detail, perms } = vi.hoisted(() => ({ detail: vi.fn(), perms: { list: [] as string[] } }));

vi.mock("../../vendor/scm/lib/so-amendment-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/so-amendment-queries")>()),
  useAmendmentDetail: detail,
}));
vi.mock("../../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useSalesOrderAuditLog: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 9, name: "Desk" }, can: (p: string) => perms.list.includes(p) }),
}));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ actorNameOf: () => "Sim" }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintPreviewModal", () => ({
  PrintPreviewModal: () => null,
  usePrintPreview: () => ({ openPreview: vi.fn(), close: vi.fn(), state: null, handlers: {} }),
}));

import { AmendmentDetailV2 } from "./AmendmentDetailV2";

afterEach(() => { cleanup(); });

const LOGISTIC = ["scm.amendment.approve_delivery"];
const PURCHASER = ["scm.amendment.approve_lines"];

const mount = (opts: { perms: string[]; required: boolean; okAt?: string | null }) => {
  perms.list = opts.perms;
  detail.mockReturnValue({
    data: {
      amendment: {
        id: "a2", so_doc_no: "HC-SO-2609-395", amendment_no: "HC-SO-2609-395/A2", status: "REQUESTED",
        lane: "DELIVERY", reason: "customer wants it earlier", requested_by: "staff-jason",
        created_at: "2026-10-10T02:37:00Z",
        header_changes: { customerDeliveryDate: "2026-10-15" },
        old_header_snapshot: { customerDeliveryDate: "2026-10-20" },
        purchaser_ok_at: opts.okAt ?? null, purchaser_ok_by: opts.okAt ? "staff-sim" : null,
      },
      lines: [],
      salesOrder: { doc_no: "HC-SO-2609-395", status: "IN_PRODUCTION", revision: 2 },
      purchaseOrders: [{ id: "po-1", po_number: "PO-2610-025", status: "SUBMITTED" }],
      purchaserOkRequired: opts.required,
    },
    isPending: false,
    error: null,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scm/amendments/a2"]}>
        <Routes>
          <Route path="/scm/amendments/:id" element={<AmendmentDetailV2 />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const approve = () => screen.queryByRole("button", { name: /approve delivery changes/i }) as HTMLButtonElement | null;
const okButton = () => screen.queryByRole("button", { name: /^purchaser ok$/i });

describe("SO amendment detail — Purchaser OK on a Delivery Date brought forward", () => {
  it("Logistic sees the step and cannot approve yet", () => {
    mount({ perms: LOGISTIC, required: true });
    expect(screen.getByText(/step 1 — purchaser ok/i)).toBeTruthy();
    expect(okButton()).toBeNull();
    expect(approve()?.disabled).toBe(true);
  });

  it("a Purchaser gets the Purchaser OK button", () => {
    mount({ perms: PURCHASER, required: true });
    expect(okButton()).not.toBeNull();
  });

  it("once the Purchaser OK is given, Logistic can approve", () => {
    mount({ perms: LOGISTIC, required: true, okAt: "2026-10-10T03:00:00Z" });
    expect(screen.getByText(/purchaser ok given/i)).toBeTruthy();
    expect(approve()?.disabled).toBe(false);
  });

  it("a postponement shows no step and Logistic approves alone", () => {
    mount({ perms: LOGISTIC, required: false });
    expect(screen.queryByText(/purchaser ok/i)).toBeNull();
    expect(approve()?.disabled).toBe(false);
  });
});
