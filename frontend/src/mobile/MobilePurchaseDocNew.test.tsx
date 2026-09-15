/* Creating a PO / GRN / PI directly on the phone must actually WRITE — and
 * must refuse exactly what the desktop refuses.
 *
 * FAILS ON THE PRE-FIX CODE — the screen did not exist.
 *
 * Drives the REAL screen: real vendored create/post hooks, real NotifyProvider,
 * real MoneyInput. Only `authedFetch` is faked (so the requests themselves are
 * the assertions) and the SKU picker sheet is stubbed to hand back one catalog
 * row, since the catalog query is not what is under test.
 */
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));

/* The picker hands back the catalog row it would have: note the SELLING price
   (99,900 sen) — the screen must NOT carry it onto a purchase line. */
const picked = { current: { itemCode: "PILLOW-STD", itemGroup: "accessory", name: "Standard Pillow", unitPriceSen: 99_900, category: "ACCESSORY" } };
vi.mock("./MobileSkuPicker", () => ({
  MobileSkuPicker: ({ onPick }: { onPick: (s: unknown) => void }) => (
    <button onClick={() => onPick(picked.current)}>stub-pick</button>
  ),
}));

import { MobilePurchaseDocNew } from "./MobilePurchaseDocNew";
import { NotifyProvider } from "../vendor/scm/components/NotifyDialog";
import type { PurchaseDocKind } from "./mobile-purchase-doc";

afterEach(cleanup);

type Call = { url: string; init?: RequestInit & { headers?: Record<string, string> } };
const calls = (): Call[] => authedFetch.mock.calls.map(([url, init]) => ({ url: String(url), init }));
const writes = () => calls().filter((c) => c.init?.method && c.init.method !== "GET");
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body ?? "{}"));

let serverRefusal: unknown = null;

beforeEach(() => {
  serverRefusal = null;
  picked.current = { itemCode: "PILLOW-STD", itemGroup: "accessory", name: "Standard Pillow", unitPriceSen: 99_900, category: "ACCESSORY" };
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/suppliers")) return { suppliers: [{ id: "sup-1", code: "OHANA", name: "Ohana Furniture", status: "ACTIVE" }] };
    if (url.startsWith("/inventory/warehouses")) return { warehouses: [{ id: "wh-1", code: "KL WAREHOUSE", name: "KL" }] };
    if (method === "POST" && serverRefusal) throw serverRefusal;
    if (method === "POST" && url === "/mfg-purchase-orders") return { id: "po-1", poNumber: "PO-2609-100" };
    if (method === "POST" && url === "/grns") return { id: "grn-1", grnNumber: "GRN-2609-100" };
    if (method === "POST" && url === "/purchase-invoices") return { id: "pi-1", invoiceNumber: "PI-2609-100" };
    if (method === "PATCH") return {};
    return {};
  });
});

const mount = (kind: PurchaseDocKind, over: { onConvertInstead?: { label: string; open: () => void } | null } = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <NotifyProvider>
        <MobilePurchaseDocNew kind={kind} onBack={vi.fn()} onCreated={onCreated} onConvertInstead={over.onConvertInstead ?? null} />
      </NotifyProvider>
    </QueryClientProvider>,
  );
  return { onCreated, invalidate };
};

/** Fill the header and one line: supplier, (warehouse), item, price 12.50. */
const fill = async (kind: PurchaseDocKind, price: string | null = "12.50") => {
  const supplier = await screen.findByLabelText("Supplier");
  await screen.findByRole("option", { name: "OHANA — Ohana Furniture" });
  await userEvent.selectOptions(supplier, "sup-1");
  if (kind !== "pi") {
    const wh = screen.getByLabelText(kind === "po" ? "Purchase location" : "Receive into");
    await screen.findByRole("option", { name: "KL WAREHOUSE" });
    await userEvent.selectOptions(wh, "wh-1");
  }
  await userEvent.click(screen.getByRole("button", { name: "+ Add item" }));
  await userEvent.click(screen.getByRole("button", { name: "stub-pick" }));
  if (price === null) return;
  const priceBox = screen.getByLabelText(`Unit price ${picked.current.itemCode}`);
  await userEvent.clear(priceBox);
  await userEvent.type(priceBox, price);
  fireEvent.blur(priceBox);
};

const okDialog = async () => userEvent.click(await screen.findByRole("button", { name: "OK" }));

describe("MobilePurchaseDocNew — what it refuses before sending", () => {
  it("keeps both save buttons off until supplier, warehouse and an item are there, and says why", async () => {
    mount("grn");
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Receive & post" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Pick the supplier.");
    await fill("grn");
    expect((screen.getByRole("button", { name: "Receive & post" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refuses to CONFIRM a bedframe PO missing its options — and sends nothing", async () => {
    picked.current = { itemCode: "TRION (A) (HB STR)-(K)", itemGroup: "bedframe", name: "Trion King", unitPriceSen: 0, category: "BEDFRAME" };
    const { onCreated } = mount("po");
    await fill("po");
    await userEvent.click(screen.getByRole("button", { name: "Confirm PO" }));
    expect(await screen.findByText("Complete the product options before confirming this PO:")).toBeTruthy();
    expect(screen.getByText(/TRION \(A\) \(HB STR\)-\(K\): Divan Height, Leg Height, Gap, Fabrics/)).toBeTruthy();
    expect(writes()).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("lets the same bedframe PO be SAVED AS A DRAFT, as desktop does", async () => {
    picked.current = { itemCode: "TRION (A) (HB STR)-(K)", itemGroup: "bedframe", name: "Trion King", unitPriceSen: 0, category: "BEDFRAME" };
    const { onCreated } = mount("po");
    await fill("po");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await okDialog();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const [post] = writes();
    expect(post.url).toBe("/mfg-purchase-orders");
    expect(bodyOf(post)).toMatchObject({ asDraft: true, supplierId: "sup-1", purchaseLocationId: "wh-1" });
  });
});

describe("MobilePurchaseDocNew — what it sends", () => {
  it("GRN: creates the manual receipt with an idempotency key, posts it, refreshes the phone lists", async () => {
    const { onCreated, invalidate } = mount("grn");
    await fill("grn", "12.50");
    await userEvent.click(screen.getByRole("button", { name: "Receive & post" }));
    expect(await screen.findByText("Goods receipt GRN-2609-100 created")).toBeTruthy();
    await okDialog();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const [create, post] = writes();
    expect(create.url).toBe("/grns");
    expect(create.init?.headers?.["Idempotency-Key"]).toBeTruthy();
    expect(bodyOf(create)).toMatchObject({ purchaseOrderId: null, supplierId: "sup-1", warehouseId: "wh-1", asDraft: false });
    /* 12.50 typed = 1250 sen. NOT the picker's 99,900 selling price. */
    expect(bodyOf(create).items).toEqual([expect.objectContaining({ itemCode: "PILLOW-STD", qtyReceived: 1, qtyAccepted: 1, unitPriceSen: 1250 })]);
    expect(post).toMatchObject({ url: "/grns/grn-1/post", init: { method: "PATCH" } });

    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(["mobile-module"]));
    expect(keys).toContain(JSON.stringify(["mobile-module-paged"]));
  });

  it("PI: creates the manual invoice then POSTS it — without the post no liability is booked", async () => {
    const { onCreated } = mount("pi");
    await fill("pi", "8");
    await userEvent.type(screen.getByLabelText("Supplier invoice no."), "INV-55");
    await userEvent.click(screen.getByRole("button", { name: "Confirm & post" }));
    await okDialog();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const [create, post] = writes();
    expect(create.url).toBe("/purchase-invoices");
    expect(bodyOf(create)).toMatchObject({ grnId: null, purchaseOrderId: null, supplierInvoiceRef: "INV-55", asDraft: false });
    expect(bodyOf(create).items[0]).toMatchObject({ unitPriceSen: 800, qty: 1 });
    expect(post).toMatchObject({ url: "/purchase-invoices/pi-1/post", init: { method: "PATCH" } });
  });

  it("a PI DRAFT is not posted", async () => {
    mount("pi");
    await fill("pi");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await okDialog();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(bodyOf(writes()[0])).toMatchObject({ asDraft: true });
  });

  it("never carries the catalog SELLING price onto a purchase line the buyer did not price", async () => {
    const { onCreated } = mount("po");
    await fill("po", null);
    expect((screen.getByLabelText("Unit price PILLOW-STD") as HTMLInputElement).value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await okDialog();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bodyOf(writes()[0]).items[0].unitPriceSen).toBe(0);
  });

  it("takes the buyer's price when they type straight into the new line's box (no clearing first)", async () => {
    /* A "0.00" box drops every keystroke that lands before its select-on-focus
       fires ("0.00" + "1" is refused as 3 decimals) — reproduced in a real
       375px render, where "12.50" typed that way saved RM 0. A blank box has
       nothing to collide with. */
    const { onCreated } = mount("grn");
    await fill("grn", null);
    const box = screen.getByLabelText("Unit price PILLOW-STD") as HTMLInputElement;
    expect(box.value).toBe("");
    box.focus();
    for (const ch of "12.50") fireEvent.change(box, { target: { value: box.value + ch } });
    expect(box.value).toBe("12.50");
    fireEvent.blur(box);
    await userEvent.click(screen.getByRole("button", { name: "Receive & post" }));
    await okDialog();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bodyOf(writes()[0]).items[0].unitPriceSen).toBe(1250);
  });

  it("PO: an accessory line confirms straight away", async () => {
    const { onCreated } = mount("po");
    await fill("po");
    await userEvent.click(screen.getByRole("button", { name: "Confirm PO" }));
    await okDialog();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(bodyOf(writes()[0])).toMatchObject({ asDraft: false, items: [expect.objectContaining({ materialKind: "mfg_product", unitPriceSen: 1250 })] });
  });
});

describe("MobilePurchaseDocNew — refusals reach the operator", () => {
  it("a zero-cost receipt refusal names the line and what it normally costs, and nothing is left open", async () => {
    serverRefusal = Object.assign(new Error("409"), {
      status: 409,
      body: JSON.stringify({
        error: "zero_cost_receipt",
        message: "These lines would receive stock at zero cost.",
        remedy: ["Enter the unit price from the supplier's delivery note."],
        lines: [{ id: null, itemCode: "PILLOW-STD", qtyAccepted: 1, knownUnitCostSen: 1500 }],
      }),
    });
    const { onCreated } = mount("grn");
    await fill("grn", "0");
    await userEvent.click(screen.getByRole("button", { name: "Receive & post" }));
    expect(await screen.findByText("Goods receipt not saved")).toBeTruthy();
    expect(screen.getByText(/PILLOW-STD x1/)).toBeTruthy();
    expect(screen.getByText(/normally about RM 15\.00 each/)).toBeTruthy();
    expect(writes().map((w) => w.url)).toEqual(["/grns"]);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("any other refusal shows the server's own words", async () => {
    serverRefusal = Object.assign(new Error("Select a warehouse to receive the goods into."), { status: 400 });
    mount("grn");
    await fill("grn");
    await userEvent.click(screen.getByRole("button", { name: "Receive & post" }));
    expect(await screen.findByText("Select a warehouse to receive the goods into.")).toBeTruthy();
  });
});

describe("MobilePurchaseDocNew — the convert flow stays one tap away", () => {
  it("offers the convert wizard when the phone has one", async () => {
    const open = vi.fn();
    mount("po", { onConvertInstead: { label: "From a Sales Order instead", open } });
    await userEvent.click(screen.getByRole("button", { name: "From a Sales Order instead" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
