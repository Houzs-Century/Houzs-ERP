/* The Delivery Returns list's ONE Export is AutoCount's Delivery Return Detail
 * Listing (owner 2026-09-15): one sheet row per LINE, every return the list's
 * tab and search match (not the 500 the screen read holds), the grid's visible
 * columns in on-screen order, AutoCount's default columns by default, money in
 * RINGGIT — never the stored sen — including the ERP-only money columns a
 * finance viewer can show.
 *
 * Harness shape: PurchaseReturnsListV2.export.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DR_LINE_COLUMNS } from "../../vendor/scm/lib/return-line-export-columns";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  csv: [] as Array<{ name: string; text: string }>,
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
  downloadCSV: (name: string, text: string) => { h.csv.push({ name, text }); },
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "edit" }),
}));
vi.mock("../../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth/salesAccess")>()),
  canViewScmCosting: () => h.finance,
}));
vi.mock("../../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: (_a: unknown, _b: unknown, fallback: string) => fallback }) }));
vi.mock("../../vendor/scm/lib/delivery-return-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/delivery-return-queries")>()),
  useDeliveryReturns: () => ({ data: { deliveryReturns: h.rows }, isLoading: false, error: null }),
  useDeliveryReturnDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateDeliveryReturnStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));

import { DeliveryReturnsListV2 } from "./DeliveryReturnsListV2";
import { ToastProvider } from "../../hooks/useToast";

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  item_code: "HOK-5530 SOFA",
  description: "HOK SOFA - 5530",
  description2: "Color :BO315-31/seater 28inch (2+L)",
  notes: null,
  item_group: "SOFA",
  condition: "GOOD",
  uom: "SET",
  qty_returned: 1,
  unit_price_sen: 350000,
  discount_sen: 1500,
  line_total_sen: 348500,
  location: "PG",
  so_doc_no: "HC-SO-013389",
  ...over,
});

const dr = (id: string, returnNumber: string, over: Record<string, unknown> = {}) => ({
  id,
  return_number: returnNumber,
  do_doc_no: "HC-DO-2608-001",
  delivery_order_id: "do-1",
  so_doc_no: "HC-SO-013389",
  return_date: "2026-08-18",
  debtor_name: "Mr Tan",
  debtor_code: "300-C002",
  salesperson_id: "staff-1",
  sales_location: "PG",
  customer_so_no: null,
  ref: null,
  branding: "HOUZS",
  venue: null,
  reason: "wrong colour",
  status: "RECEIVED",
  currency: "MYR",
  local_total_sen: 697000,
  bedframe_sen: 125050,
  total_cost_sen: 400000,
  ac_agent: "MEI TING",
  lines: [line(`${id}-l1`), line(`${id}-l2`, { item_code: "HOK-LONG PILLOW", qty_returned: 2, unit_price_sen: 175025, discount_sen: 0, line_total_sen: 350050, location: "KL" })],
  ...over,
});

const all = [
  dr("d-1", "HC-DR-2608-0001"),
  dr("d-2", "HC-DR-2608-0002", { status: "CANCELLED" }),
  dr("d-3", "HC-DR-2608-0003", { debtor_name: "Swee Jia Wei" }),
];

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <DeliveryReturnsListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.csv = [];
  h.finance = false;
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/delivery-returns/export/rows")) return { deliveryReturns: all, total: 3, lineCount: 6, truncated: false };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const exportNow = async (url: string) => {
  mount(url);
  const buttons = screen.getAllByRole("button", { name: /^Export/ });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(h.written).toHaveLength(1));
  const [header, ...body] = h.aoa as [string[], ...unknown[][]];
  const cell = (row: unknown[], label: string, nth = 0) => {
    const idx = header.map((l, i) => (l === label ? i : -1)).filter((i) => i >= 0).at(nth);
    if (idx === undefined) throw new Error(`no column ${label}`);
    return row[idx];
  };
  return { header, body, cell };
};

describe("Delivery Returns list: the ONE Export", () => {
  it("writes AutoCount's default Detail Listing columns, in AutoCount's order, one row per line of every return the server holds", async () => {
    const { header, body, cell } = await exportNow("/scm/delivery-returns");
    expect(header).toEqual(DR_LINE_COLUMNS.filter((c) => c.autoCount).map((c) => c.label));
    expect(header.slice(0, 5)).toEqual(["Doc No", "Doc Date", "Debtor Code", "Debtor Name", "Agent"]);
    expect(body).toHaveLength(6);
    expect(body.map((r) => cell(r, "Item Code"))).toEqual([
      "HOK-5530 SOFA", "HOK-LONG PILLOW", "HOK-5530 SOFA", "HOK-LONG PILLOW", "HOK-5530 SOFA", "HOK-LONG PILLOW",
    ]);
    expect(cell(body[0]!, "Agent")).toBe("MEI TING");
    expect(cell(body[0]!, "Doc Date")).toBe("2026-08-18");
    expect(cell(body[1]!, "Location")).toBe("KL");
    expect(cell(body[2]!, "Cancelled")).toBe("Yes");
    expect(h.written[0]).toMatch(/^delivery-returns-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(h.csv).toHaveLength(0);
  });

  it("follows the tab and the search across every return, not the screen read", async () => {
    h.rows = [all[2]!];
    const beyond = dr("d-4", "HC-DR-2608-0004", { debtor_name: "Swee Jia Wei" });
    h.authed.mockImplementation(async () => ({ deliveryReturns: [...all, beyond], total: 4, lineCount: 8, truncated: false }));
    const { body, cell } = await exportNow("/scm/delivery-returns?status=open&q=swee");
    expect([...new Set(body.map((r) => cell(r, "Doc No")))]).toEqual(["HC-DR-2608-0003", "HC-DR-2608-0004"]);
  });

  it("no money cell is in sen: amounts in ringgit, the unit price a rate", async () => {
    const { body, cell } = await exportNow("/scm/delivery-returns");
    expect(cell(body[0]!, "Unit Price")).toBe(3500);
    expect(cell(body[1]!, "Unit Price")).toBe(1750.25);
    expect(cell(body[0]!, "Discount")).toBe(15);
    expect(cell(body[0]!, "Total", 1)).toBe(3485);
    expect(cell(body[1]!, "Total (Ex)")).toBe(3500.5);
    expect(cell(body[1]!, "Total (Inc)")).toBe(3500.5);
    expect(cell(body[0]!, "Total", 0)).toBe(6970);
    expect(cell(body[0]!, "SubTotal (Ex)")).toBe(6970);
    expect(cell(body[0]!, "Local Total")).toBe(6970);
    expect(cell(body[0]!, "Curr. Rate")).toBe(1);
    const sen = new Set([350000, 175025, 1500, 348500, 350050, 697000, 125050, 400000]);
    for (const row of body) for (const v of row) expect(sen.has(v as number)).toBe(false);
  });

  it("the file follows the visible columns: a hidden default drops out, a shown ERP money column exports in ringgit", async () => {
    h.finance = true;
    localStorage.setItem("dt:hidden:delivery-returns-v2", JSON.stringify(["proj_no", "dept_no"]));
    localStorage.setItem("dt:shown:delivery-returns-v2", JSON.stringify(["bedframe_sen", "total_cost_sen", "status", "detail_description_2"]));
    const { header, body, cell } = await exportNow("/scm/delivery-returns");
    expect(header).not.toContain("Proj No");
    expect(header).not.toContain("Dept No");
    expect(cell(body[0]!, "Bedframe")).toBe(1250.5);
    expect(cell(body[0]!, "Total Cost")).toBe(4000);
    expect(cell(body[0]!, "Status")).toBe("Received");
    expect(cell(body[0]!, "Detail Description 2")).toBe("Color :BO315-31/seater 28inch (2+L)");
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ deliveryReturns: all, total: 20000, lineCount: 0, truncated: true }));
    mount("/scm/delivery-returns");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
