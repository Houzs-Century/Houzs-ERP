/* The Delivery Orders list's ONE Export (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I show").
 *
 * Mounts the real page with its data hooks faked; the network and the sheet
 * writer are the seams asserted:
 *   - there is ONE Export, and it asks /delivery-orders-mfg/export/rows with the
 *     list's tab and search, no page;
 *   - the file's columns are the grid's visible columns, in on-screen order;
 *   - the file holds one row per LINE of every delivery order the server
 *     matched, not the page on screen, and the grid's funnel applies;
 *   - no money cell is in sen;
 *   - the "AutoCount: LISTING ITEM DETAIL" layout exports AutoCount's columns
 *     and no price;
 *   - a stopped read writes no file.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primeInVisitColFilters, resetInVisitColFilters } from "../../components/dataTableColFilterMemory";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  csv: [] as string[],
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
vi.mock("../../lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/csv")>()),
  downloadCSV: (name: string) => { h.csv.push(name); },
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "edit" }),
}));
vi.mock("../../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth/salesAccess")>()),
  canViewScmCosting: () => h.finance,
  canOperateDeliveryOrders: () => true,
}));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: (_a: unknown, _b: unknown, fallback = "") => fallback }) }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));
vi.mock("../../vendor/scm/lib/delivery-order-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/delivery-order-queries")>()),
  useMfgDeliveryOrdersPaged: () => ({
    data: {
      deliveryOrders: h.rows, total: 3, page: 0, pageSize: 1,
      statusCounts: { all: 3, draft: 0, loaded: 0, dispatched: 0, in_transit: 0, delivered: 3, invoiced: 0, on_hold: 0, cancelled: 0 },
    },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useMfgDeliveryOrderDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateMfgDeliveryOrderStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("./use-do-cancel-action", () => ({ useDoCancelAction: () => ({ cancelDo: vi.fn() }) }));
vi.mock("./use-hold-action", () => ({ useHoldAction: () => vi.fn() }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));

import { MfgDeliveryOrdersListV2 } from "./MfgDeliveryOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, line_no: 1, item_code: "AK-CODY (K)", erp_item_code: "CODY-(K)", description: "AKEMI CODY MATTRESS (K)",
  description2: "FABRIC KN-12", item_group: "MATTRESS", uom: "UNIT", location: "KL", qty: 2, m3: 1.25,
  delivery_date: "2026-09-20", remark: null, invoiced_qty: 0, returned_qty: 0, uninvoiced_qty: 2,
  so_doc_no: "HC-SO-013389", invoice_nos: [], po_nos: ["HC-PO-009951"], ...over,
});
const dOrder = (id: string, doNumber: string, lines: unknown[], over: Record<string, unknown> = {}) => ({
  id, do_number: doNumber, ac_doc_no: `DO-${doNumber.slice(-6)}`, ac_debtor_code: "300-C001", ac_agent: "MEI TING",
  so_doc_no: "HC-SO-013389", do_date: "2026-09-12", expected_delivery_at: null, customer_delivery_date: "2026-09-20",
  debtor_name: "Mr Tan", debtor_code: "300-C001", salesperson_id: "staff-1", sales_location: "KL", customer_so_no: null,
  po_doc_no: null, source_pos: [], source_sos: ["HC-SO-013389"], ref: null, branding: "HOUZS", driver_name: null,
  vehicle: null, phone: null, email: null, address1: null, address2: null, city: null, postcode: null, customer_state: null,
  status: "DELIVERED", on_hold: false, currency: "MYR", local_total_sen: 697000, invoiced_si_nos: [], return_nos: [],
  venue: null, note: null, customer_type: null, building_type: null, bedframe_sen: 125050, total_cost_sen: 400000,
  lines, ...over,
});

const all = [
  dOrder("d-1", "HC-DO-2609-000601", [line("l-1"), line("l-2", { line_no: 2, item_code: "AK-BASTION (Q)", qty: 1, uninvoiced_qty: 1 })]),
  dOrder("d-2", "HC-DO-2609-000602", [line("l-3")], { debtor_name: "Swee Jia Wei" }),
  dOrder("d-3", "HC-DO-2609-000603", [line("l-4", { item_code: "HOK-5530 SOFA", item_group: "SOFA", location: "PG" })]),
];

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <MfgDeliveryOrdersListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  // The SCREEN holds one delivery order; the filtered set holds three with four lines.
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.csv = [];
  h.finance = false;
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/delivery-orders-mfg/export/rows")) return { deliveryOrders: all, total: 3, lineCount: 4, next: null };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetInVisitColFilters();
});

const exportNow = async () => {
  const buttons = screen.getAllByRole("button", { name: /^Export( lines)?$/ });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(h.written).toHaveLength(1));
  const [header, ...body] = h.aoa as [string[], ...unknown[][]];
  const cell = (row: unknown[], label: string) => {
    const idx = header.indexOf(label);
    if (idx < 0) throw new Error(`no column ${label}`);
    return row[idx];
  };
  return { header, body, cell };
};

/** The grid's header captions, left to right, as the operator sees them. */
const gridHeader = (): string[] =>
  Array.from(document.querySelectorAll("table thead th"))
    .map((th) => th.textContent.trim())
    .filter((t) => t !== "");

describe("Delivery Orders list: the ONE Export", () => {
  it("asks the server for every delivery order under the list's tab and search, not a page", async () => {
    mount("/scm/delivery-orders?status=delivered&q=HC-DO-2609&page=2");
    await exportNow();
    const path = h.authed.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/delivery-orders-mfg/export/rows"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("delivered");
    expect(params.get("q")).toBe("HC-DO-2609");
    expect(params.has("page")).toBe(false);
    expect(params.has("pageSize")).toBe(false);
    expect(h.csv).toHaveLength(0);
  });

  it("the grid's visible columns become the file's columns, in on-screen order, one row per line", async () => {
    mount("/scm/delivery-orders");
    const onScreen = gridHeader();
    const { header, body, cell } = await exportNow();
    expect(onScreen.length).toBeGreaterThan(5);
    expect(header).toEqual(onScreen);
    // 2 + 1 + 1 lines across the three delivery orders the server matched.
    expect(body).toHaveLength(4);
    expect(body.map((r) => cell(r, "Doc No"))).toEqual(["DO-000601", "DO-000601", "DO-000602", "DO-000603"]);
    expect(body.map((r) => cell(r, "Item Code"))).toEqual(["AK-CODY (K)", "AK-BASTION (Q)", "AK-CODY (K)", "HOK-5530 SOFA"]);
    expect(body.map((r) => cell(r, "Qty"))).toEqual([2, 1, 2, 2]);
    expect(h.written[0]).toMatch(/^delivery-orders-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("a hidden column drops out of the file and a shown one comes in", async () => {
    localStorage.setItem("dt:hidden:delivery-orders-v2", JSON.stringify(["detail_description_2"]));
    localStorage.setItem("dt:shown:delivery-orders-v2", JSON.stringify(["vehicle", "status"]));
    mount("/scm/delivery-orders");
    const { header, body, cell } = await exportNow();
    expect(header).not.toContain("Detail Description 2");
    expect(header).toContain("Vehicle");
    expect(header).toContain("Driver");
    expect(cell(body[0]!, "Status")).toBe("Delivered");
  });

  it("follows the grid's funnel over the whole fetched set", async () => {
    const beyond = dOrder("d-4", "HC-DO-2609-000604", [line("l-5", { item_code: "AK-BASTION (Q)" })]);
    h.authed.mockImplementation(async () => ({ deliveryOrders: [...all, beyond], total: 4, lineCount: 5, next: null }));
    primeInVisitColFilters("delivery-orders-v2", { item_code: ["AK-BASTION (Q)"] });
    mount("/scm/delivery-orders");
    const { body, cell } = await exportNow();
    // The funnel keeps a WHOLE delivery order that has a Bastion line — on the
    // screen page or beyond it — and drops the ones that have none.
    expect(body.map((r) => cell(r, "Doc No"))).toEqual(["DO-000601", "DO-000601", "DO-000604"]);
    expect(body.map((r) => cell(r, "Item Code"))).toEqual(["AK-CODY (K)", "AK-BASTION (Q)", "AK-BASTION (Q)"]);
  });

  it("writes NO money cell in sen: a shown amount or category column is ringgit", async () => {
    h.finance = true;
    localStorage.setItem("dt:shown:delivery-orders-v2", JSON.stringify(["amount", "bedframe_sen", "total_cost_sen"]));
    mount("/scm/delivery-orders");
    const { body, cell } = await exportNow();
    expect(cell(body[0]!, "Amount")).toBe(6970);
    expect(cell(body[0]!, "Bedframe")).toBe(1250.5);
    expect(cell(body[0]!, "Total Cost")).toBe(4000);
    const sen = new Set([697000, 125050, 400000]);
    for (const row of body) for (const v of row) expect(sen.has(v as number)).toBe(false);
  });

  it("the AutoCount LISTING ITEM DETAIL layout exports AutoCount's columns and no price", async () => {
    h.finance = true;
    mount("/scm/delivery-orders");
    fireEvent.click(screen.getByTitle(/^Columns/));
    fireEvent.click(screen.getByRole("button", { name: /^Layout/ }));
    fireEvent.click(screen.getByRole("option", { name: /AutoCount: LISTING ITEM DETAIL/ }));
    const { header, body, cell } = await exportNow();
    expect(header).toEqual([
      "Doc No", "Doc Date", "Debtor Code", "Debtor Name", "Agent", "Curr. Code", "Item Code", "Detail Description",
      "Detail Description 2", "UOM", "Location", "Qty", "PO Doc No.", "Item Group",
    ]);
    expect(body).toHaveLength(4);
    expect(body[0]).toEqual([
      "DO-000601", "2026-09-12", "300-C001", "Mr Tan", "MEI TING", "MYR", "AK-CODY (K)", "AKEMI CODY MATTRESS (K)",
      "FABRIC KN-12", "UNIT", "KL", 2, "HC-PO-009951", "MATTRESS",
    ]);
    expect(cell(body[3]!, "Location")).toBe("PG");
  });

  it("does not change the default layout: a fresh grid still hides the amount", () => {
    mount("/scm/delivery-orders");
    expect(gridHeader()).not.toContain("Amount");
    expect(gridHeader()).toContain("Item Code");
  });

  it("refuses to hand over a short file past the export's document limit", async () => {
    // A full 20,000-document window that still says there is more.
    const many = Array.from({ length: 20000 }, (_, i) => ({ id: `d-many-${i}`, do_number: `HC-DO-${i}`, status: "DELIVERED", lines: [] }));
    h.authed.mockImplementation(async () => ({ deliveryOrders: many, total: 20000, lineCount: 0, next: 20000 }));
    mount("/scm/delivery-orders");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
