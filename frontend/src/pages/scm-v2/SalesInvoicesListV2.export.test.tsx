/* The Sales Invoices list's exports hold EVERY invoice its filters match, not
 * the screen page (owner 2026-09-15: one row per line item, the whole filtered
 * listing).
 *
 * The toolbar Export wrote DataTable's `sortedRows` — the one page the server
 * had sent. Both exports now ask the server for the whole filtered set, with the
 * SAME tab and search the list is showing; the server applies the caller's
 * sales scope. Export lines is a read, so a caller who cannot write invoices
 * still gets it. Mounts the real page with its data hooks faked; the network is
 * the one seam asserted. Same harness as PurchaseOrdersListV2.export.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SI_LINE_EXPORT_COLUMNS } from "../../vendor/scm/lib/si-line-export-columns";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  csv: [] as Array<{ name: string; text: string }>,
  notify: vi.fn(async (..._a: unknown[]) => {}),
  rows: [] as Array<Record<string, unknown>>,
  canWrite: true,
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
vi.mock("../../lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/csv")>()),
  downloadCSV: (name: string, text: string) => { h.csv.push({ name, text }); },
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => h.canWrite, pageAccess: () => (h.canWrite ? "edit" : "view") }),
}));
vi.mock("../../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth/salesAccess")>()),
  canOperateSalesInvoices: () => h.canWrite,
  canViewScmCosting: () => false,
}));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: (_a: unknown, _b: unknown, fallback: string) => fallback }) }));
vi.mock("../../vendor/scm/lib/sales-invoice-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/sales-invoice-queries")>()),
  useSalesInvoicesPaged: () => ({
    data: { salesInvoices: h.rows, total: 3, page: 0, pageSize: 1, statusCounts: { all: 3, sent: 3, partial: 0, paid: 0, cancelled: 0 } },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useSalesInvoiceDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateSalesInvoiceStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { SalesInvoicesListV2 } from "./SalesInvoicesListV2";
import { ToastProvider } from "../../hooks/useToast";

const si = (id: string, invoiceNumber: string, over: Record<string, unknown> = {}) => ({
  id,
  invoice_number: invoiceNumber,
  so_doc_no: "HC-SO-013389",
  delivery_order_id: null,
  do_number: null,
  debtor_code: "300-C001",
  debtor_name: "TAN AH KOW",
  invoice_date: "2026-09-12",
  due_date: null,
  currency: "MYR",
  total_sen: 130000,
  local_total_sen: 130000,
  paid_sen: 0,
  so_deposit_applied_sen: 0,
  source_pos: [],
  status: "SENT",
  created_at: "2026-09-12T02:00:00Z",
  ...over,
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

const all = [si("s-1", "HC-SI-2609-001"), si("s-2", "HC-SI-2609-002", { status: "OVERDUE" }), si("s-3", "HC-SI-2609-003")];

beforeEach(() => {
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.csv = [];
  h.canWrite = true;
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/sales-invoices/export/lines")) {
      return {
        columns: [...SI_LINE_EXPORT_COLUMNS],
        rows: [
          SI_LINE_EXPORT_COLUMNS.map((c) => (c === "Line ID" ? "line-1" : c === "Doc No" ? "HC-SI-2609-001" : null)),
          SI_LINE_EXPORT_COLUMNS.map((c) => (c === "Line ID" ? "line-2" : c === "Doc No" ? "HC-SI-2609-003" : null)),
        ],
        siCount: 3,
        lineCount: 2,
        truncated: false,
      };
    }
    if (path.startsWith("/sales-invoices/export/headers")) return { salesInvoices: all, total: 3, truncated: false };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const calledPaths = () => h.authed.mock.calls.map((c) => String(c[0]));

describe("Sales Invoices list: Export lines", () => {
  it("asks the server for every line under the list's current tab and search", async () => {
    mount("/scm/sales-invoices?status=sent&q=TAN&page=2");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.written).toHaveLength(1));
    const path = calledPaths().find((p) => p.startsWith("/sales-invoices/export/lines"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("sent");
    expect(params.get("q")).toBe("TAN");
    expect(params.has("page")).toBe(false);
  });

  it("writes one sheet row per line under the contract header", async () => {
    mount("/scm/sales-invoices?status=sent");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.written).toHaveLength(1));
    expect(h.aoa[0]).toEqual([...SI_LINE_EXPORT_COLUMNS]);
    expect(h.aoa).toHaveLength(3);
    expect(h.written[0]).toMatch(/^sales-invoice-lines-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("is offered to a reader who cannot write invoices", async () => {
    h.canWrite = false;
    mount("/scm/sales-invoices");
    expect(screen.getByRole("button", { name: "Export lines" })).toBeTruthy();
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ columns: [...SI_LINE_EXPORT_COLUMNS], rows: [], siCount: 20000, lineCount: 0, truncated: true }));
    mount("/scm/sales-invoices");
    fireEvent.click(screen.getByRole("button", { name: "Export lines" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});

describe("Sales Invoices list: the toolbar Export", () => {
  it("exports every invoice under the list's filters, not the page on screen, with the status word", async () => {
    mount("/scm/sales-invoices?status=sent&q=TAN");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.csv).toHaveLength(1));
    const path = calledPaths().find((p) => p.startsWith("/sales-invoices/export/headers"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("sent");
    expect(params.get("q")).toBe("TAN");
    const text = h.csv[0]!.text;
    for (const r of all) expect(text).toContain(r.invoice_number);
    expect(text).toContain("Overdue");
    expect(text).not.toContain("SENT");
  });
});
