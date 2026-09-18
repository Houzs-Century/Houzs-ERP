/* "Print all" on the Purchase Order list opens the Print preview (owner
 * 2026-09-14, over the Delivery Order list's preview: 「PO打印没有这个」).
 *
 * The list used to go straight from the button to "One combined PDF / Separate
 * files" and a file in Downloads, with no preview and no Print now. It now
 * shares the other lists' dialog: the preview names the stack, Print now and
 * View render ONE merged document without asking, and only Download still asks
 * combined-vs-separate. Mounts the real page with its data hooks faked.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gen: vi.fn(async (..._a: unknown[]) => {}),
  genCombined: vi.fn(async (..._a: unknown[]) => {}),
  choose: vi.fn(async (..._a: unknown[]): Promise<string | null> => "one"),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../vendor/scm/lib/purchase-order-pdf", () => ({
  generatePurchaseOrderPdf: h.gen,
  generateCombinedPurchaseOrderPdf: h.genCombined,
}));
vi.mock("../../vendor/scm/lib/suppliers-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/suppliers-queries")>()),
  usePurchaseOrdersPaged: () => ({
    data: {
      purchaseOrders: h.rows,
      total: h.rows.length,
      page: 0,
      pageSize: 50,
      statusCounts: { all: h.rows.length, draft: 0, outstanding: h.rows.length, open: h.rows.length, partial: 0, received: 0, cancelled: 0, on_hold: 0 },
    },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useEnrichedPoListRows: (rows: unknown[]) => rows,
  usePurchaseOrderDetail: () => ({ data: undefined, isLoading: false, error: null }),
  fetchPurchaseOrderDetail: async (id: string) => ({
    purchaseOrder: h.rows.find((r) => r.id === id),
    items: [],
  }),
}));
vi.mock("../../vendor/scm/lib/inventory-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/inventory-queries")>()),
  useWarehouses: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/flow-queries")>()),
  usePoSoCoverage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./use-hold-action", () => ({ useHoldAction: () => ({ hold: vi.fn(), release: vi.fn(), dialog: null }) }));
vi.mock("./use-po-cancel-action", () => ({ usePoCancelAction: () => ({ cancelPo: vi.fn() }) }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => h.choose }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { PurchaseOrdersListV2 } from "./PurchaseOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const po = (id: string, poNumber: string, revision = 1) => ({
  id,
  po_number: poNumber,
  revision,
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-D001", name: "DIGLANT MANUFACTURING SDN BHD." },
  status: "SUBMITTED",
  po_date: "2026-09-12",
  expected_at: "2026-09-20",
  currency: "MYR",
  subtotal_sen: 130000,
  tax_sen: 0,
  total_sen: 130000,
  notes: null,
  submitted_at: "2026-09-12T02:00:00Z",
  received_at: null,
  cancelled_at: null,
  purchase_location_id: null,
  purchase_location: null,
  created_at: "2026-09-12T02:00:00Z",
  created_by: "u-1",
  updated_at: "2026-09-12T02:00:00Z",
  items: [],
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/scm/purchase-orders"]}>
        <ToastProvider>
          <PurchaseOrdersListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const tick = (n: number) => {
  const boxes = screen.getAllByLabelText("Select row");
  for (let i = 0; i < n; i += 1) fireEvent.click(boxes[i]!);
};

/* The page also carries other dialogs (the row drawer), so the preview is found
   by its own title rather than by role alone. */
const openPreview = async (n: number): Promise<HTMLElement> => {
  tick(n);
  fireEvent.click(screen.getByRole("button", { name: `Print all (${n})` }));
  const title = await screen.findByText("Print preview");
  const dialog = title.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("the Print preview title is not inside a dialog");
  return dialog;
};

beforeEach(() => {
  h.rows = [po("po-1", "HC-PO-2609-092"), po("po-2", "HC-PO-2609-093", 2), po("po-3", "HC-PO-2609-094")];
  h.gen.mockClear();
  h.genCombined.mockClear();
  h.choose.mockReset();
  h.choose.mockResolvedValue("one");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Purchase Order list: Print all goes through the Print preview", () => {
  it("opens the preview naming the stack instead of printing straight away", async () => {
    mount();
    const dialog = await openPreview(2);
    expect(within(dialog).getByText("Purchase Orders")).toBeTruthy();
    expect(within(dialog).getByText("2 documents")).toBeTruthy();
    // The revised order is named as the list shows it.
    expect(within(dialog).getByText(/HC-PO-2609-092 · HC-PO-2609-093_R1/)).toBeTruthy();
    expect(h.choose).not.toHaveBeenCalled();
    expect(h.gen).not.toHaveBeenCalled();
    expect(h.genCombined).not.toHaveBeenCalled();
  });

  it("Print now renders one merged document for the printer, without asking combined-or-separate", async () => {
    mount();
    const dialog = await openPreview(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Print now" }));
    await waitFor(() => expect(h.genCombined).toHaveBeenCalledTimes(1));
    expect(h.choose).not.toHaveBeenCalled();
    expect(h.genCombined.mock.calls[0]![1]).toMatchObject({ action: "print" });
    expect((h.genCombined.mock.calls[0]![0] as unknown[]).length).toBe(2);
  });

  it("Download still asks combined-or-separate, and Separate files downloads one PDF per order", async () => {
    h.choose.mockResolvedValue("many");
    mount();
    const dialog = await openPreview(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(h.gen).toHaveBeenCalledTimes(2));
    expect(h.choose).toHaveBeenCalledTimes(1);
    expect(h.genCombined).not.toHaveBeenCalled();
    for (const call of h.gen.mock.calls) expect(call[2]).toMatchObject({ action: "save" });
  });

  it("one ticked order prints on its own with the action it was given", async () => {
    mount();
    const dialog = await openPreview(1);
    expect(within(dialog).getByText("1 document")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Print now" }));
    await waitFor(() => expect(h.gen).toHaveBeenCalledTimes(1));
    expect(h.gen.mock.calls[0]![2]).toMatchObject({ action: "print" });
    expect(h.choose).not.toHaveBeenCalled();
  });
});
