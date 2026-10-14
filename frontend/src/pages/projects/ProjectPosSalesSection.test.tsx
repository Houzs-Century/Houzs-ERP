/* The POS Sales section of a Cash & Carry project (layout E9). Pinned: an
   event with no synced bill still shows the section with its Export and
   Total Sales buttons; a bill lists by receipt and opens to its item rows
   with the Disc wording; Total Sales writes the NET takings (paid minus
   returns) through the project finance PATCH; a viewer without the Sales
   section sees nothing and fires no read. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { QueryState } from "../../hooks/useQuery";
import type { PosReceipt, ProjectPosSalesResponse } from "../../lib/projectPosSales";

const patch = vi.fn(async () => ({}));
let canView = true;
let canFinance = true;
let posQuery: QueryState<ProjectPosSalesResponse>;
const used = vi.fn();

vi.mock("../../api/client", () => ({ api: { patch: (p: string, b: unknown) => patch(p, b) } }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1 }, can: () => true }) }));
vi.mock("../../auth/salesAccess", () => ({ canWriteProjectFinance: () => canFinance }));
vi.mock("../../hooks/useProjectSalesBills", () => ({ useCanViewProjectSales: () => ({ canLogSale: canView, canViewSales: canView }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: async () => true, prompt: async () => null }) }));
vi.mock("../../hooks/useProjectPosSales", () => ({
  useProjectPosSales: (projectId: number, filter: unknown, enabled: boolean) => {
    used(projectId, filter, enabled);
    return posQuery;
  },
}));

import { ProjectPosSalesSection } from "./ProjectPosSalesSection";

const receipt = (over: Partial<PosReceipt> & { id: number; receipt_no: string }): PosReceipt => ({
  uuid: `u${over.id}`, type: "SALE", ref_sale_uuid: null, terminal_code: "T02", cashier_id: 7, cashier_name: "Aina",
  salesman_id: null, salesman_name: null, customer_name: null, customer_phone: null, sold_at: "2026-10-14T06:00:00.000Z",
  subtotal_sen: 10000, item_discount_sen: 1000, bill_discount_sen: 0, sst_applied: false, sst_rate: 0, sst_amount_sen: 0,
  rounding_sen: 0, total_sen: 9000, status: "PAID", void_reason: null, void_by: null, voided_at: null, source: "NORMAL",
  synced_at: "", methods: ["QR"], payments: [{ method: "QR", amount_sen: 9000, reference: "A1B2" }],
  lines: [{ line_no: 1, item_code: "PL-01", description: "Pillow", qty: 2, uom: "UNIT", unit_price_sen: 5000, original_price_sen: null, override_reason: null, disc_label: "-10%", discount_amount_sen: 1000, is_foc: false, amount_sen: 9000 }],
  ...over,
});

const response = (rows: PosReceipt[]): ProjectPosSalesResponse => ({
  project: { id: 9, name: "AEON Tebrau C&C", event_type_slug: "cash_carry" },
  pos_enabled: true,
  data: rows,
  totals: {
    count: rows.length,
    paid_count: rows.filter((r) => r.status === "PAID" && r.type === "SALE").length,
    void_count: rows.filter((r) => r.status === "VOID").length,
    return_count: rows.filter((r) => r.status === "PAID" && r.type === "RETURN").length,
    net_sen: rows.reduce((s, r) => (r.status === "VOID" ? s : r.type === "RETURN" ? s - r.total_sen : s + r.total_sen), 0),
    sales_sen: 0, return_sen: 0, void_sen: 0, discount_sen: 0, sst_sen: 0,
    by_method: { QR: 9000 },
  },
  all_count: rows.length,
  options: { terminals: ["T02"], cashiers: [{ id: 7, name: "Aina" }], methods: ["QR"] },
});

const query = (over: Partial<QueryState<ProjectPosSalesResponse>>): QueryState<ProjectPosSalesResponse> => ({
  data: null, loading: false, fetching: false, placeholder: false, error: null, reload: () => {}, ...over,
});

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() } as never;
const mount = () => render(<ProjectPosSalesSection projectId={9} currentTotalSales={null} onTotalSaved={() => {}} toast={toast} />);

beforeEach(() => {
  patch.mockClear();
  used.mockClear();
  canView = true;
  canFinance = true;
});

describe("ProjectPosSalesSection", () => {
  test("an event with no bill yet still shows the section, Export and Total Sales", () => {
    posQuery = query({ data: response([]) });
    mount();
    expect(screen.getByText("POS Sales (0)")).toBeTruthy();
    expect(screen.getByText(/No POS sales yet/)).toBeTruthy();
    expect((screen.getByText("Export").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Total Sales").closest("button")).toBeTruthy();
  });

  test("a bill lists by receipt and opens to its item rows", () => {
    posQuery = query({ data: response([receipt({ id: 1, receipt_no: "T02-000001", salesman_name: "Farah", salesman_id: 3 })]) });
    mount();
    expect(screen.getByText("POS Sales (1)")).toBeTruthy();
    /* The first "Total" is the header tile; the table's Total column comes after. */
    expect((screen.getAllByText("Total")[0]!.nextSibling)?.textContent).toBe("RM 90.00");
    const row = screen.getByText("T02-000001").closest("tr")!;
    expect(row.textContent).toContain("Aina");
    expect(row.textContent).toContain("Farah");
    expect(row.textContent).toContain("PT");
    expect(row.textContent).toContain("QR / DuitNow RM 90.00");
    expect(within(row).getByText("PAID")).toBeTruthy();
    expect(screen.queryByText("Pillow")).toBeNull();
    fireEvent.click(row);
    const lines = screen.getByText("Pillow").closest("tr")!;
    expect(lines.textContent).toContain("PL-01");
    expect(lines.textContent).toContain("2 UNIT");
    expect(lines.textContent).toContain("-10%");
    expect(lines.textContent).toContain("RM 90.00");
    expect(screen.getByText(/A1B2/)).toBeTruthy();
  });

  test("Total Sales writes the net takings, paid bills minus returns, to the project finance", async () => {
    posQuery = query({
      data: response([
        receipt({ id: 1, receipt_no: "T02-000001" }),
        receipt({ id: 2, receipt_no: "R-T02-000002", type: "RETURN", total_sen: 2550 }),
        receipt({ id: 3, receipt_no: "T02-000003", status: "VOID", void_reason: "wrong item" }),
      ]),
    });
    mount();
    expect(screen.getByText("POS Sales (3)")).toBeTruthy();
    expect(screen.getByText("VOID")).toBeTruthy();
    expect(screen.getByText("RETURN")).toBeTruthy();
    fireEvent.click(screen.getByText("Total Sales"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/9/finance", { total_sales: 64.5 }));
  });

  test("without finance write the Total Sales button is absent; without Sales view nothing renders and nothing is read", () => {
    posQuery = query({ data: response([]) });
    canFinance = false;
    const { unmount } = mount();
    expect(screen.queryByText("Total Sales")).toBeNull();
    expect(screen.getByText("Export")).toBeTruthy();
    unmount();
    canView = false;
    const { container } = mount();
    expect(container.textContent).toBe("");
    expect(used).toHaveBeenLastCalledWith(9, expect.anything(), false);
  });
});
