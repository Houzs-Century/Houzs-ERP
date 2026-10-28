/* "Add line" on the phone document detail must actually WRITE the line, offer
 * itself only where the desktop would, and keep a refusal on screen.
 *
 * FAILS ON THE PRE-FIX CODE — the component did not exist.
 *
 * Drives the REAL component and the REAL vendored add-item hooks. Faked: only
 * `authedFetch` (so the requests are the assertions), `useAuth` (the access
 * matrix under test), and the SKU picker sheet (the catalog is not under test).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));

const auth = vi.hoisted(() => ({
  levels: {} as Record<string, string>,
  user: { id: 1, email: "o@x.test", name: "O", position_name: "Account Executive", department_name: "Account Department", permissions: [] } as Record<string, unknown>,
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: auth.user, can: () => false, pageAccess: (p: string) => auth.levels[p] ?? "none" }),
}));

vi.mock("./MobileSkuPicker", () => ({
  MobileSkuPicker: ({ onPick }: { onPick: (s: unknown) => void }) => (
    <button onClick={() => onPick({ itemCode: "PILLOW-STD", itemGroup: "accessory", name: "Standard Pillow", unitPriceSen: 99_900, category: "ACCESSORY" })}>stub-pick</button>
  ),
}));

import { MobileAddLine } from "./MobileAddLine";
import { ADD_LINE_LABEL } from "../vendor/scm/lib/add-line-handoff";

afterEach(cleanup);
beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ item: {} });
  auth.levels = { "scm.procurement.po": "edit", "scm.procurement.grn": "edit", "scm.procurement.pi": "edit", "scm.sales.invoices": "edit" };
});

const mount = (moduleKey: string, header: Record<string, unknown> | null, docId = "doc-1") => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const onAdded = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MobileAddLine moduleKey={moduleKey} docId={docId} header={header} onAdded={onAdded} />
    </QueryClientProvider>,
  );
  return { onAdded, invalidate };
};

const posts = () => authedFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const body = (i = 0) => JSON.parse(String((posts()[i][1] as RequestInit).body));

const openPickPrice = async (price: string) => {
  await userEvent.click(screen.getByRole("button", { name: `+ ${ADD_LINE_LABEL}` }));
  await userEvent.click(screen.getByRole("button", { name: "Pick an item" }));
  await userEvent.click(screen.getByRole("button", { name: "stub-pick" }));
  const box = screen.getByLabelText("Unit price") as HTMLInputElement;
  expect(box.value).toBe("");
  box.focus();
  for (const ch of price) fireEvent.change(box, { target: { value: box.value + ch } });
  fireEvent.blur(box);
};

describe("MobileAddLine — where it is offered", () => {
  it("prints the shared word on an open document", () => {
    mount("grns", { status: "POSTED", has_children: false });
    expect(screen.getByRole("button", { name: `+ ${ADD_LINE_LABEL}` })).toBeTruthy();
  });

  it("is absent for a view-only holder", () => {
    auth.levels = { "scm.procurement.grn": "view" };
    mount("grns", { status: "POSTED", has_children: false });
    expect(screen.queryByRole("button", { name: `+ ${ADD_LINE_LABEL}` })).toBeNull();
  });

  it("is absent on a purchase order that already has a goods receipt", () => {
    mount("mfg-purchase-orders", { status: "SUBMITTED", has_children: true });
    expect(screen.queryByRole("button", { name: `+ ${ADD_LINE_LABEL}` })).toBeNull();
  });

  it("is absent on a delivery order — the desktop has no manual add there either", () => {
    mount("delivery-orders-mfg", { status: "LOADED" });
    expect(screen.queryByRole("button", { name: `+ ${ADD_LINE_LABEL}` })).toBeNull();
  });
});

describe("MobileAddLine — what it sends", () => {
  it("GRN: posts the manual line with the typed price, refreshes the detail and the phone lists, closes", async () => {
    const { onAdded, invalidate } = mount("grns", { status: "POSTED", has_children: false, received_at: "2026-09-13T08:00:00Z" }, "grn-1");
    await openPickPrice("12.50");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(posts()[0][0]).toBe("/grns/grn-1/items");
    expect(body()).toEqual({ purchaseOrderItemId: null, materialKind: "mfg_product", itemCode: "PILLOW-STD", materialName: "Standard Pillow", itemGroup: "accessory", qty: 1, unitPriceSen: 1250, deliveryDate: "2026-09-13" });
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(["mobile-module-paged"]));
    expect(screen.getByRole("button", { name: `+ ${ADD_LINE_LABEL}` })).toBeTruthy();
  });

  it("SI: posts to the sales invoice with the SalesInvoiceAddLine body", async () => {
    const { onAdded } = mount("sales-invoices", { status: "DRAFT" }, "si-1");
    await openPickPrice("80");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(posts()[0][0]).toBe("/sales-invoices/si-1/items");
    expect(body()).toEqual({ itemCode: "PILLOW-STD", description: "Standard Pillow", qty: 1, unitPriceSen: 8000, discountSen: 0, uom: "UNIT" });
  });

  it("PO and PI post to their own item endpoints", async () => {
    mount("mfg-purchase-orders", { status: "DRAFT", has_children: false }, "po-1");
    await openPickPrice("5");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe("/mfg-purchase-orders/po-1/items");
    cleanup();
    authedFetch.mockClear();
    mount("purchase-invoices", { status: "POSTED", paid_sen: 0 }, "pi-1");
    await openPickPrice("5");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe("/purchase-invoices/pi-1/items");
  });
});

describe("MobileAddLine — a refusal stays on screen", () => {
  it("shows the server's words beside the row, keeps what was typed, and does not report success", async () => {
    authedFetch.mockRejectedValue(Object.assign(new Error("That item is not in the catalog for this company."), { status: 409 }));
    const { onAdded } = mount("purchase-invoices", { status: "DRAFT", paid_sen: 0 }, "pi-1");
    await openPickPrice("5");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That item is not in the catalog for this company.");
    expect((screen.getByLabelText("Unit price") as HTMLInputElement).value).toBe("5.00");
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("names the line and its usual cost on a zero-cost receipt refusal", async () => {
    authedFetch.mockRejectedValue(Object.assign(new Error("409"), {
      status: 409,
      body: JSON.stringify({ error: "zero_cost_receipt", message: "This line would receive stock at zero cost.", remedy: ["Enter the unit price."], lines: [{ id: null, itemCode: "PILLOW-STD", qtyAccepted: 1, knownUnitCostSen: 1500 }] }),
    }));
    mount("grns", { status: "POSTED", has_children: false }, "grn-1");
    await openPickPrice("0");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("PILLOW-STD x1");
    expect(alert.textContent).toContain("normally about RM 15.00 each");
  });
});
