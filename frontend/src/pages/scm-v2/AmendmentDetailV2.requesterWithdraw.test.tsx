/* The person who raised an SO amendment can see Withdraw on it.
 *
 * 2026-10-05, HC-SO-011143/A1: Syu raised it (BUG-53 put a phantom pillow
 * colour change in it) and had no Withdraw button, because the page compared
 * requested_by with an scm staff id the browser never has. The server now says
 * whether the caller raised it (viewerIsRequester); the page reads that.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detail } = vi.hoisted(() => ({ detail: vi.fn() }));

vi.mock("../../vendor/scm/lib/so-amendment-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/so-amendment-queries")>()),
  useAmendmentDetail: detail,
}));
vi.mock("../../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useSalesOrderAuditLog: () => ({ data: [], isLoading: false, isError: false }),
}));
/* A salesperson: no approve permission on any lane. */
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 41, name: "Syu" }, can: () => false }) }));
vi.mock("../../hooks/useBreadcrumbs", () => ({ useSetBreadcrumbs: () => undefined }));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ actorNameOf: () => "Syu" }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintPreviewModal", () => ({
  PrintPreviewModal: () => null,
  usePrintPreview: () => ({ openPreview: vi.fn(), close: vi.fn(), state: null, handlers: {} }),
}));

import { AmendmentDetailV2 } from "./AmendmentDetailV2";

afterEach(() => { cleanup(); });

const mount = (viewerIsRequester: boolean | undefined, status = "REQUESTED") => {
  detail.mockReturnValue({
    data: {
      amendment: {
        id: "a1", so_doc_no: "HC-SO-011143", amendment_no: "HC-SO-011143/A1", status, lane: "LINES",
        reason: "add on storage charges", requested_by: "staff-syu", created_at: "2026-10-03T03:01:00Z",
      },
      lines: [],
      salesOrder: { doc_no: "HC-SO-011143", status: "READY_TO_SHIP", revision: 2 },
      purchaseOrders: [],
      ...(viewerIsRequester === undefined ? {} : { viewerIsRequester }),
    },
    isPending: false,
    error: null,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scm/amendments/a1"]}>
        <Routes>
          <Route path="/scm/amendments/:id" element={<AmendmentDetailV2 />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const withdrawButton = () => screen.queryByRole("button", { name: /withdraw this request/i });

describe("SO amendment detail — Withdraw for the person who raised it", () => {
  it("shows Withdraw to the requester even without any approve permission", () => {
    mount(true);
    expect(withdrawButton()).not.toBeNull();
  });

  it("hides Withdraw from someone else without approve permission", () => {
    mount(false);
    expect(withdrawButton()).toBeNull();
  });

  it("hides Withdraw when the server does not say (an older backend)", () => {
    mount(undefined);
    expect(withdrawButton()).toBeNull();
  });

  it("hides Withdraw once the request has been acted on", () => {
    mount(true, "SO_APPROVED");
    expect(withdrawButton()).toBeNull();
  });
});
