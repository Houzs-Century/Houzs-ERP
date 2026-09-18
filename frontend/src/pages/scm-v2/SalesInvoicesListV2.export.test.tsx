/* The Sales Invoices list's ONE Export (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I show").
 *
 * Mounts the real page with its data hooks faked; the network and the sheet
 * writer are the seams asserted:
 *   - the Export asks /sales-invoices/export/rows with the list's tab and search, no page;
 *   - the file holds one row per LINE of every invoice, not the page on screen;
 *   - a fresh grid exports the list's own columns (owner: 「默认跟我的data grid啊」); AutoCount's wait in the chooser;
 *   - money cells are ringgit numbers, never sen;
 *   - a stopped read writes no file.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  notify: vi.fn(async (..._a: unknown[]) => {}),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: h.authed,
}));
vi.mock("../../lib/xlsx-runtime", () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => { h.aoa = aoa; return {}; },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.written.push(name); },
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "edit" }),
}));
vi.mock("../../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth/salesAccess")>()),
  canOperateSalesInvoices: () => true,
  canViewScmCosting: () => false,
}));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: (_a: unknown, _b: unknown, fallback: string) => fallback }) }));
vi.mock("../../vendor/scm/lib/sales-invoice-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/sales-invoice-queries")>()),
  useSalesInvoicesPaged: () => ({
    data: { salesInvoices: h.rows, total: 2, page: 0, pageSize: 1, statusCounts: { all: 2, sent: 2, partial: 0, paid: 0, cancelled: 0 } },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useSalesInvoiceDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateSalesInvoiceStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/flow-queries")>()),
  usePoSoCoverage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./use-hold-action", () => ({ useHoldAction: () => ({ hold: vi.fn(), release: vi.fn(), dialog: null }) }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { SalesInvoicesListV2 } from "./SalesInvoicesListV2";
import { ToastProvider } from "../../hooks/useToast";

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, item_code: "CODY-(K)", ac_item_code: "AK-CODY (K)", book_description: "AKEMI CODY MATTRESS (K)", book_item_group: "MATTRESS",
  book_uom: "UNIT", description: "CODY KING", description2: "FABRIC KN-12", remarks: null, item_group: "mattress", uom: "UNIT",
  location: "KL", qty: 2, unit_price_sen: 150000.5, discount_sen: 0, line_total_sen: 300001, delivery_date: "2026-09-20",
  do_no: "HC-DO-2609-001", ...over,
});
const si = (id: string, invoiceNumber: string, lines: unknown[], over: Record<string, unknown> = {}) => ({
  id, invoice_number: invoiceNumber, linked_ac_docno: `I-${invoiceNumber.slice(-8)}`, ac_agent: "Zack", so_doc_no: "HC-SO-013389",
  delivery_order_id: null, do_number: null, debtor_code: "300-C001", debtor_name: "TAN AH KOW", invoice_date: "2026-09-12",
  due_date: null, currency: "MYR", subtotal_sen: 300001, tax_sen: 0, total_sen: 300001, local_total_sen: 300001, paid_sen: 0,
  so_deposit_applied_sen: 0, source_pos: [], status: "SENT", created_at: "2026-09-12T02:00:00Z", lines, ...over,
});

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <SalesInvoicesListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const all = [
  si("s-1", "HC-SI-2609-001", [line("l-1"), line("l-2", { ac_item_code: "AK-BASTION (Q)" })]),
  si("s-2", "HC-SI-2609-002", [line("l-3")]),
];

beforeEach(() => {
  // The SCREEN holds one receipt; the filtered set holds two with three lines.
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/sales-invoices/export/rows")) return { salesInvoices: all, total: 2, lineCount: 3, truncated: false };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const exportNow = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(h.written).toHaveLength(1));
};

describe("Sales Invoices list: the one Export", () => {
  it("asks the server for every invoice under the list's tab and search, not a page", async () => {
    mount("/scm/sales-invoices?status=sent&q=TAN&page=2");
    await exportNow();
    const path = h.authed.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/sales-invoices/export/rows"));
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("sent");
    expect(params.get("q")).toBe("TAN");
    expect(params.has("page")).toBe(false);
    expect(screen.queryByRole("button", { name: "Export lines" })).toBeNull();
  });

  it("writes the grid's own default columns, one row per line", async () => {
    mount("/scm/sales-invoices?status=sent");
    await exportNow();
    expect(h.aoa[0]).toEqual([
      "SI No.", "Date", "Due", "Transfer From (SO)", "Transfer From (DO)", "Source PO", "Customer", "Customer ref", "Status",
      "Outstanding", "Total",
    ]);
    expect(h.aoa).toHaveLength(4);
    expect(h.aoa.slice(1).map((r) => r[0])).toEqual(["HC-SI-2609-001", "HC-SI-2609-001", "HC-SI-2609-002"]);
    expect(h.written[0]).toMatch(/^sales-invoices-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("writes money as ringgit, never sen", async () => {
    mount("/scm/sales-invoices");
    await exportNow();
    const header = h.aoa[0] as string[];
    for (const label of ["Outstanding", "Total"]) {
      const i = header.indexOf(label);
      for (const row of h.aoa.slice(1)) expect(row[i], `${label} looks like sen`).toBe(3000.01);
    }
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ salesInvoices: [], total: 0, lineCount: 0, truncated: true }));
    mount("/scm/sales-invoices");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
