/* The Purchase Returns list's ONE Export is AutoCount's Purchase Return Detail
 * Listing (owner 2026-09-15): one sheet row per LINE, every return the list's
 * tab and search match (not the 300 the screen read holds), the grid's visible
 * columns in on-screen order, AutoCount's default columns by default, and money
 * in RINGGIT — never the stored sen.
 *
 * Mounts the real page with its list hook faked; the network and the xlsx writer
 * are the seams asserted. Harness shape: PurchaseInvoicesListV2.export.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PR_LINE_COLUMNS } from "../../vendor/scm/lib/return-line-export-columns";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  csv: [] as Array<{ name: string; text: string }>,
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
vi.mock("../../lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/csv")>()),
  downloadCSV: (name: string, text: string) => { h.csv.push({ name, text }); },
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit", user: null }) }));
vi.mock("../../vendor/scm/lib/purchase-return-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/purchase-return-queries")>()),
  usePurchaseReturns: () => ({ data: { purchaseReturns: h.rows }, isLoading: false, error: null }),
  usePurchaseReturnDetail: () => ({ data: undefined, isLoading: false, error: null }),
  usePostPurchaseReturn: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelPurchaseReturn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));

import { PurchaseReturnsListV2 } from "./PurchaseReturnsListV2";
import { ToastProvider } from "../../hooks/useToast";

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  item_code: "AN-DINING CHAIR",
  material_name: "ANNEX DINING CHAIR",
  description: null,
  description2: "9-11 REFER DR000038",
  notes: null,
  reason: null,
  item_group: "dining",
  uom: "UNIT",
  qty_returned: 8,
  unit_price_sen: 18000,
  line_refund_sen: 136800,
  location: "PG",
  grn_no: "HC-GRN-000610",
  po_no: "HC-PO-009951",
  ...over,
});

const pr = (id: string, returnNumber: string, over: Record<string, unknown> = {}) => ({
  id,
  return_number: returnNumber,
  return_date: "2025-10-28",
  status: "POSTED",
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-A003", name: "ANNEX DESIGN SDN BHD" },
  grn: { id: "g-1", grn_number: "HC-GRN-000610", currency: "MYR", warehouse_id: "wh-pg" },
  purchase_order: null,
  refund_sen: 207950,
  credit_note_ref: "CN-251008",
  reason: "ITEM DAMAGED-CUSTOMER REJECTED",
  notes: null,
  lines: [line(`${id}-l1`), line(`${id}-l2`, { qty_returned: 6, unit_price_sen: 12500, line_refund_sen: 71150, location: "KL" })],
  ...over,
});

/* The screen read holds one return; the server holds three. */
const all = [
  pr("p-1", "HC-PRT-2610-0001"),
  pr("p-2", "HC-PRT-2610-0002", { status: "CANCELLED" }),
  pr("p-3", "HC-PRT-2610-0003", { supplier: { id: "sup-2", code: "400-T005", name: "TODERN HOME SDN BHD" } }),
];

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <PurchaseReturnsListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.rows = [all[0]!];
  h.aoa = [];
  h.written = [];
  h.csv = [];
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/purchase-returns/export/rows")) return { purchaseReturns: all, total: 3, lineCount: 6, truncated: false };
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

describe("Purchase Returns list: the ONE Export", () => {
  it("writes AutoCount's default Detail Listing columns, in AutoCount's order, one row per line of every return the server holds", async () => {
    const { header, body, cell } = await exportNow("/scm/purchase-returns");
    expect(header).toEqual(PR_LINE_COLUMNS.filter((c) => c.autoCount).map((c) => c.label));
    expect(header.slice(0, 5)).toEqual(["Doc No", "Doc Date", "Creditor Code", "Creditor Name", "Agent"]);
    expect(body).toHaveLength(6);
    expect(body.map((r) => cell(r, "Doc No"))).toEqual([
      "HC-PRT-2610-0001", "HC-PRT-2610-0001", "HC-PRT-2610-0002", "HC-PRT-2610-0002", "HC-PRT-2610-0003", "HC-PRT-2610-0003",
    ]);
    expect(body.map((r) => cell(r, "Location"))).toEqual(["PG", "KL", "PG", "KL", "PG", "KL"]);
    expect(cell(body[0]!, "Cancelled")).toBe("No");
    expect(cell(body[2]!, "Cancelled")).toBe("Yes");
    expect(h.written[0]).toMatch(/^purchase-returns-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(h.csv).toHaveLength(0);
  });

  it("follows the tab and the search across every return, not the screen read", async () => {
    h.rows = [all[2]!];
    const beyondTheScreen = pr("p-4", "HC-PRT-2610-0004", { supplier: { id: "sup-2", code: "400-T005", name: "TODERN HOME SDN BHD" } });
    const cancelledTodern = pr("p-5", "HC-PRT-2610-0005", { status: "CANCELLED", supplier: { id: "sup-2", code: "400-T005", name: "TODERN HOME SDN BHD" } });
    h.authed.mockImplementation(async () => ({ purchaseReturns: [...all, beyondTheScreen, cancelledTodern], total: 5, lineCount: 10, truncated: false }));
    const { body, cell } = await exportNow("/scm/purchase-returns?status=posted&q=TODERN");
    expect(body.map((r) => cell(r, "Doc No"))).toEqual(["HC-PRT-2610-0003", "HC-PRT-2610-0003", "HC-PRT-2610-0004", "HC-PRT-2610-0004"]);
  });

  it("no money cell is in sen: every amount is ringgit, the unit price a rate", async () => {
    const { body, cell } = await exportNow("/scm/purchase-returns");
    const first = body[0]!;
    const second = body[1]!;
    expect(cell(first, "Unit Price")).toBe(180);
    expect(cell(second, "Unit Price")).toBe(125);
    expect(cell(first, "Total", 1)).toBe(1368);
    expect(cell(second, "Total", 1)).toBe(711.5);
    expect(cell(first, "Total (Ex)")).toBe(1368);
    expect(cell(first, "Total (Inc)")).toBe(1368);
    expect(cell(first, "Local Total", 1)).toBe(1368);
    expect(cell(first, "Total", 0)).toBe(2079.5);
    expect(cell(first, "SubTotal (Ex)")).toBe(2079.5);
    expect(cell(first, "Final Total")).toBe(2079.5);
    expect(cell(first, "Local Total", 0)).toBe(2079.5);
    expect(cell(first, "Tax", 0)).toBe(0);
    const senValues = new Set([18000, 12500, 136800, 71150, 207950]);
    for (const row of body) for (const v of row) expect(senValues.has(v as number)).toBe(false);
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ purchaseReturns: all, total: 20000, lineCount: 0, truncated: true }));
    mount("/scm/purchase-returns");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
