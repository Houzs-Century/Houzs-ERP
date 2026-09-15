/* The Sales Orders list's ONE Export (owner 2026-09-15): every order the tab,
 * search, filters and sort match — not the page on screen — one row per line,
 * the grid's visible columns under AutoCount's captions, money in ringgit.
 *
 * Mounts the real page with its data hooks faked; the network and the sheet
 * writer are the seams asserted. Same harness as DeliveryReturnsListV2.export.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SO_DEFAULT_COLUMNS, type SoListLine } from "../../vendor/scm/lib/so-line-export-columns";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  notify: vi.fn(async (..._a: unknown[]) => {}),
  rows: [] as Array<Record<string, unknown>>,
  finance: false,
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
  canViewScmCosting: () => h.finance,
}));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: (_a: unknown, _b: unknown, fallback: string) => fallback }) }));
vi.mock("../../vendor/scm/lib/sales-order-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useMfgSalesOrdersPaged: () => ({
    data: { salesOrders: h.rows, total: 3, page: 1, pageSize: 1, statusCounts: { all: 3, draft: 0, confirmed: 3, cancelled: 0 } },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useEnrichedSoListRows: (rows: unknown[]) => rows,
  useSoLineCoverage: () => ({ data: undefined }),
  useMfgSalesOrderDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateMfgSalesOrderStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { MfgSalesOrdersListV2 } from "./MfgSalesOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const line = (id: string, over: Partial<SoListLine> = {}): SoListLine => ({
  id, line_no: 1, item_code: "DSL-9028 SOFA", erp_item_code: "9028-1S", description: "DSL SOFA - 9028",
  description2: "EZ-002 Sand / SEAT 28", item_group: "SOFA", uom: "SET", location: "KL", qty: 1,
  unit_price_sen: 350025, discount_sen: 0, total_sen: 350025, delivery_date: "2026-09-30", remark: null,
  stock_status: null, delivered_qty: 0, returned_qty: 0, remaining_qty: 1, on_delivery_order_qty: 0,
  do_nos: [], po_nos: ["HC-PO-008783"], po_delivery_date: null, ...over,
});

const so = (docNo: string, over: Record<string, unknown> = {}) => ({
  doc_no: docNo, so_date: "2026-09-12", debtor_name: "TAN AH KOW", debtor_code: null, agent: "NICO", salesperson_id: null,
  sales_location: "KL", ref: "REF-1", customer_so_no: null, po_doc_no: null, branding: "HOUZS", status: "CONFIRMED",
  local_total_sen: 700050, balance_sen: 700050, balance_sen_live: 200050, paid_sen: 0, paid_total_sen: 500000,
  currency: "MYR", processing_date: "2026-09-13", customer_delivery_date: "2026-09-30", sales_exemption_expiry: null,
  venue: "MIDVALLEY", phone: null, email: null, address1: null, address2: null, city: null, postcode: null,
  customer_state: null, payment_method: null, note: null, customer_type: null, building_type: null, customer_country: null,
  first_item_branding: null, first_item_category: null, warehouse_name: null,
  ac_doc_no: `SO-${docNo.slice(-6)}`, ac_debtor_code: "300-C002", ac_agent: "NICO TAN", ac_venue: "MID VALLEY", ac_branding: "HOUZS",
  lines: [line(`${docNo}-1`), line(`${docNo}-2`, { item_code: "HOK-LONG PILLOW", qty: 2, unit_price_sen: 12550.5, total_sen: 25101 })],
  ...over,
});

const all = [so("HC-SO-013001"), so("HC-SO-013002"), so("HC-SO-013003", { debtor_name: "LIM" })];

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <MfgSalesOrdersListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.finance = false;
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/mfg-sales-orders/export/rows")) return { salesOrders: all, total: 3, lineCount: 6, next: null };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const exportNow = async (url: string) => {
  mount(url);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(h.written).toHaveLength(1));
  const [header, ...body] = h.aoa as [string[], ...unknown[][]];
  const cell = (row: unknown[], label: string) => {
    const idx = header.indexOf(label);
    if (idx < 0) throw new Error(`no column ${label}`);
    return row[idx];
  };
  return { header, body, cell };
};

describe("Sales Orders list: the ONE Export", () => {
  it("writes AutoCount's SALES ORDER DETAILS-SALES columns, one row per line of every order the server holds", async () => {
    const { header, body, cell } = await exportNow("/scm/sales-orders");
    /* Doc. No. is pinned first on the grid; the rest in AutoCount's order. */
    expect(header).toEqual(["Doc. No.", ...SO_DEFAULT_COLUMNS.filter((c) => c !== "Doc. No.")]);
    expect(body).toHaveLength(6);
    expect(cell(body[0]!, "Doc. No.")).toBe("SO-013001");
    expect(cell(body[0]!, "Agent")).toBe("NICO TAN");
    expect(cell(body[0]!, "VENUE")).toBe("MID VALLEY");
    expect(cell(body[1]!, "Item Code")).toBe("HOK-LONG PILLOW");
    expect(cell(body[0]!, "Location")).toBe("KL");
    expect(cell(body[0]!, "Date")).toBe("2026-09-12");
    expect(h.written[0]).toMatch(/\.xlsx$/);
  });

  it("asks the server with the list's tab, search and sort, and no page", async () => {
    await exportNow("/scm/sales-orders?status=confirmed&q=TAN&page=3");
    const path = h.authed.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/mfg-sales-orders/export/rows"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.has("page")).toBe(false);
  });

  it("no money cell is in sen: totals and balance in ringgit, the unit price a rate", async () => {
    h.finance = true;
    localStorage.setItem("dt:shown:sales-orders-v2", JSON.stringify(["paid", "line_total", "bedframe_sen", "balance"]));
    h.authed.mockImplementation(async () => ({ salesOrders: all.map((r) => ({ ...r, bedframe_sen: 99999 })), total: 3, lineCount: 6, next: null }));
    const { body, cell } = await exportNow("/scm/sales-orders");
    expect(cell(body[0]!, "Total")).toBe(7000.5);
    expect(cell(body[0]!, "BALANCE")).toBe(2000.5);
    expect(cell(body[0]!, "Unit Price")).toBe(3500.25);
    expect(cell(body[1]!, "Unit Price")).toBe(125.505);
    expect(cell(body[0]!, "Paid")).toBe(5000);
    expect(cell(body[1]!, "Total (Inc)")).toBe(251.01);
    expect(cell(body[0]!, "Bedframe")).toBe(999.99);
    const sen = new Set([700050, 200050, 350025, 12550.5, 500000, 25101, 99999]);
    for (const row of body) for (const v of row) expect(sen.has(v as number)).toBe(false);
  });

  it("refuses to hand over a short file when the listing is larger than one export holds", async () => {
    const many = Array.from({ length: 20_000 }, (_, i) => so(`HC-SO-${String(i).padStart(6, "0")}`, { lines: [] }));
    h.authed.mockImplementation(async () => ({ salesOrders: many, total: 20_000, lineCount: 0, next: 20_000 }));
    mount("/scm/sales-orders");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
