/* The Purchase Orders list's ONE Export (owner 2026-09-15): one row per LINE,
 * the grid's visible columns in on-screen order under their labels, over every
 * order the list's tab and search match (not the page on screen), money in
 * RINGGIT and dates as real Excel dates.
 *
 * The owner's evidence file exported one row per PO with the items squashed into
 * one cell, and Total in sen (HC-PO-009304 as 1500000 for RM15,000.00). Mounts the
 * real page with its data hooks faked; the network and the sheet are the seams
 * asserted. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PO_LINE_LABELS, type PoListLine } from "../../vendor/scm/lib/po-line-export-columns";
import { primeInVisitColFilters, resetInVisitColFilters } from "../../components/dataTableColFilterMemory";

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  cells: {} as Record<string, { t?: string; v?: unknown; z?: string }>,
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
    aoa_to_sheet: (aoa: unknown[][]) => {
      h.aoa = aoa;
      const ws: Record<string, { t?: string; v?: unknown; z?: string }> = {};
      aoa.forEach((row, r) => row.forEach((v, c) => {
        if (v === null || v === undefined) return;
        ws[`${c}:${r}`] = { t: typeof v === "number" ? "n" : "s", v };
      }));
      h.cells = ws;
      return ws;
    },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.written.push(name); },
}));
vi.mock("../../vendor/scm/lib/suppliers-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/suppliers-queries")>()),
  usePurchaseOrdersPaged: () => ({
    data: {
      purchaseOrders: h.rows,
      total: 3,
      page: 0,
      pageSize: 1,
      statusCounts: { all: 3, draft: 0, outstanding: 3, open: 3, partial: 0, received: 0, cancelled: 0, on_hold: 0 },
    },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  }),
  useEnrichedPoListRows: (rows: unknown[]) => rows,
  usePurchaseOrderDetail: () => ({ data: undefined, isLoading: false, error: null }),
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
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));
vi.mock("../../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => vi.fn() }));
vi.mock("../../components/scm-v2/PrintChainProvider", () => ({ usePrintDocument: () => vi.fn() }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../hooks/useBranding", () => ({
  useBranding: () => ({ companyName: "HOUZS CENTURY SDN BHD", companyCode: "HOUZS" }),
}));

import { PurchaseOrdersListV2 } from "./PurchaseOrdersListV2";
import { ToastProvider } from "../../hooks/useToast";

const ln = (id: string, over: Partial<PoListLine> = {}): PoListLine => ({
  id,
  line_no: 1,
  item_code: "AKEMI-GUARDIAN-(Q)",
  material_name: "AKEMI GUARDIAN MATTRESS (152X190X30CM)",
  item_description: "AKEMI GUARDIAN MATTRESS (153x190x30CM)",
  description2: "QUEEN",
  notes: null,
  item_group: "mattress",
  ac_item_group: "MATTRESS",
  supplier_sku: "AK-GUARDIAN (Q)",
  qty: 2,
  received_qty: 0,
  remaining_qty: 2,
  unit_price_sen: 5.5,
  line_total_sen: 150_000,
  delivery_date: "2026-09-20",
  estimate_delivery_date_1: "2026-09-12",
  estimate_delivery_date_2: null,
  estimate_delivery_date_3: null,
  location: "KL",
  so_doc_no: "HC-SO-013389",
  ...over,
});

const po = (id: string, poNumber: string, lines: PoListLine[], over: Record<string, unknown> = {}) => ({
  id,
  po_number: poNumber,
  linked_ac_docno: null,
  revision: 1,
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-A006", name: "AKEMI UNITED SDN BHD" },
  status: "SUBMITTED",
  po_date: "2026-09-04",
  expected_at: "2026-09-20",
  currency: "MYR",
  subtotal_sen: 1_500_000,
  tax_sen: 0,
  total_sen: 1_500_000,
  notes: null,
  purchase_location_id: null,
  purchase_location: null,
  created_at: "2026-09-04T02:00:00Z",
  items: [],
  has_children: false,
  transfer_to_grns: [],
  lines,
  ...over,
});

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <PurchaseOrdersListV2 />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const allOrders = [
  po("po-1", "HC-PO-009304", [ln("l-1"), ln("l-2", { line_no: 2, supplier_sku: "AK-BASTION (K)" })], { linked_ac_docno: "PO-009304" }),
  po("po-2", "HC-PO-009950", [ln("l-3")]),
  po("po-3", "HC-PO-009951", []),
];

beforeEach(() => {
  // The SCREEN holds one page of one order; the filtered set holds three.
  h.rows = [allOrders[0]!];
  h.aoa = [];
  h.cells = {};
  h.written = [];
  h.notify.mockClear();
  h.authed.mockReset();
  h.authed.mockImplementation(async (path: string) => {
    if (path.startsWith("/mfg-purchase-orders/export/rows")) return { purchaseOrders: allOrders, total: 3, lineCount: 3, truncated: false };
    if (path.startsWith("/mfg-purchase-orders/list-mrp-enrichment")) return { enrichment: {} };
    return {};
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetInVisitColFilters();
});

const calledPaths = () => h.authed.mock.calls.map((c) => String(c[0]));
const exportNow = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(h.written).toHaveLength(1));
};

describe("Purchase Order list: the ONE Export", () => {
  it("has no separate Export lines button", () => {
    mount("/scm/purchase-orders");
    expect(screen.queryByRole("button", { name: "Export lines" })).toBeNull();
  });

  it("asks the server for every order under the list's tab and search, not a page", async () => {
    mount("/scm/purchase-orders?status=open&q=HC-PO-0099&page=2");
    await exportNow();
    const path = calledPaths().find((p) => p.startsWith("/mfg-purchase-orders/export/rows"));
    expect(path).toBeDefined();
    const params = new URL(path!, "http://x").searchParams;
    expect(params.get("status")).toBe("open");
    expect(params.get("q")).toBe("HC-PO-0099");
    expect(params.has("page")).toBe(false);
    expect(params.has("pageSize")).toBe(false);
  });

  it("a fresh list exports AutoCount's columns, in AutoCount's order, one row per line", async () => {
    mount("/scm/purchase-orders");
    await exportNow();
    expect(h.aoa[0]).toEqual([
      "Doc No", "SO Doc No.", "Creditor Code", "Creditor Name", "Item Code", "Item Description",
      "Item Description 2", "Location", "Item Group", "Doc Date", "Remaining Qty", "Delivery Date",
      "Estimate Delivery Date", "Supplier Delivery Date 2", "Supplier Delivery Date 3",
    ]);
    // 2 + 1 lines, and the PO with no line still gets its row.
    expect(h.aoa).toHaveLength(5);
    expect(h.aoa[1]).toEqual([
      "PO-009304", "HC-SO-013389", "400-A006", "AKEMI UNITED SDN BHD", "AK-GUARDIAN (Q)",
      "AKEMI GUARDIAN MATTRESS (153x190x30CM)", "QUEEN", "KL", "MATTRESS", "2026-09-04", 2, "2026-09-20",
      "2026-09-12", null, null,
    ]);
    expect(h.aoa[2]![4]).toBe("AK-BASTION (K)");
    expect(h.aoa[3]![0]).toBe("HC-PO-009950"); // not linked to AutoCount: the ERP number
    expect(h.aoa[4]!.slice(0, 5)).toEqual(["HC-PO-009951", null, "400-A006", "AKEMI UNITED SDN BHD", null]);
    // Doc Date and the delivery dates are real Excel dates shown yyyy/mm/dd.
    expect(h.cells["9:1"]).toEqual({ t: "n", v: 46269, z: "yyyy/mm/dd" });
    expect(h.cells["11:1"]).toMatchObject({ t: "n", z: "yyyy/mm/dd" });
    expect(h.written[0]).toMatch(/^purchase-orders-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("exports only the columns the grid shows: a hidden column is not in the file", async () => {
    localStorage.setItem("dt:hidden:purchase-orders-v2", JSON.stringify(["item_description_2", "location"]));
    mount("/scm/purchase-orders");
    await exportNow();
    expect(h.aoa[0]).not.toContain("Item Description 2");
    expect(h.aoa[0]).not.toContain("Location");
    expect(h.aoa[0]).toContain("Item Code");
  });

  it("follows the grid's funnel over the whole fetched set", async () => {
    // A funnel set this visit (in-visit memory, not localStorage).
    primeInVisitColFilters("purchase-orders-v2", { item_code: ["AK-BASTION (K)"] });
    mount("/scm/purchase-orders");
    await exportNow();
    // Only PO-009304 has a Bastion line; the funnel keeps the whole PO.
    expect(h.aoa.slice(1).map((r) => r[0])).toEqual(["PO-009304", "PO-009304"]);
  });

  it("writes NO money cell in sen: Total, Unit Price and Line Total are ringgit", async () => {
    localStorage.setItem("dt:shown:purchase-orders-v2", JSON.stringify(["total", "unit_price", "line_total"]));
    mount("/scm/purchase-orders");
    await exportNow();
    const header = h.aoa[0] as string[];
    const at = (label: string) => header.indexOf(label);
    expect(at("Total")).toBeGreaterThan(-1);
    const moneyCols: Array<[string, (row: unknown[]) => unknown]> = [
      ["Total", (r) => r[at("Total")]],
      [PO_LINE_LABELS.unitPrice, (r) => r[at(PO_LINE_LABELS.unitPrice)]],
      [PO_LINE_LABELS.lineTotal, (r) => r[at(PO_LINE_LABELS.lineTotal)]],
    ];
    const first = h.aoa[1]!;
    expect(moneyCols.map(([, get]) => get(first))).toEqual([15000, 0.055, 1500]);
    // Every money cell in the file equals the stored sen / 100, never the sen.
    type Pair = { o: (typeof allOrders)[number]; l: PoListLine | null };
    const lines: Pair[] = allOrders.flatMap((o): Pair[] => (o.lines.length ? o.lines.map((l) => ({ o, l })) : [{ o, l: null }]));
    lines.forEach(({ o, l }, i) => {
      const row = h.aoa[i + 1]!;
      expect(row[at("Total")]).toBe(o.total_sen / 100);
      expect(row[at(PO_LINE_LABELS.unitPrice)]).toBe(l ? l.unit_price_sen! / 100 : null);
      expect(row[at(PO_LINE_LABELS.lineTotal)]).toBe(l ? l.line_total_sen! / 100 : null);
    });
    expect(h.cells[`${at("Total")}:1`]).toMatchObject({ t: "n", z: "#,##0.00" });
    expect(h.cells[`${at(PO_LINE_LABELS.unitPrice)}:1`]).toMatchObject({ t: "n", z: "#,##0.00##" });
  });

  it("carries the _R revision suffix on an AC-linked Doc No too (owner report 2026-09-18)", async () => {
    // Approving a PO amendment bumps `revision`, but the Doc No cell showed
    // the AC-linked number as-is (never re-derived, never suffixed) — a
    // revised PO looked identical to its own original on screen.
    h.authed.mockImplementation(async (path: string) => {
      if (path.startsWith("/mfg-purchase-orders/export/rows")) {
        return {
          purchaseOrders: [po("po-r1", "HC-PO-2609-140", [ln("l-1")], { linked_ac_docno: "AC-PO-140", revision: 2 })],
          total: 1, lineCount: 1, truncated: false,
        };
      }
      if (path.startsWith("/mfg-purchase-orders/list-mrp-enrichment")) return { enrichment: {} };
      return {};
    });
    mount("/scm/purchase-orders");
    await exportNow();
    expect(h.aoa[1]![0]).toBe("AC-PO-140_R1");
  });

  it("refuses to hand over a short file when the server stopped reading", async () => {
    h.authed.mockImplementation(async () => ({ purchaseOrders: [], total: 0, lineCount: 0, truncated: true }));
    mount("/scm/purchase-orders");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.written).toHaveLength(0);
  });
});
