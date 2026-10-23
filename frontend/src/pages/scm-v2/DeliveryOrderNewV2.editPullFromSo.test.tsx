/* HC-0146: "From Sales Order" on the Edit Delivery Order form appends the SO's
 * still-undelivered lines and saves them as new lines on the existing DO.
 *
 * FAILS ON THE PRE-FIX CODE — in edit mode the picker only set the SO doc no.,
 * the remainder query was switched off by `!editId`, and nothing was added.
 *
 * Mounts the REAL page at the real edit URL. Faked: authedFetch (the requests
 * are the assertions) and the dialog hooks.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "full" }),
}));

import { DeliveryOrderNewV2 } from "./DeliveryOrderNewV2";

afterEach(cleanup);

const SO = "HC-SO-011007";
const DOO = {
  id: "do-1", do_number: "HC-DO-2610-240", status: "LOADED", so_doc_no: SO,
  debtor_name: "MR CHOW", debtor_code: "", phone: "+6596515013", email: "",
  address1: "BLK 682 B JURONG WEST CENTRAL 1", address2: "", customer_state: "", city: "Jurong West",
  postcode: "642682", sales_location: "KL WAREHOUSE", do_date: "2026-10-17", driver_name: "",
  vehicle: "", expected_delivery_at: "2026-10-23", customer_delivery_date: "2026-10-23",
  note: "", salesperson_id: "", has_children: false,
};
const DO_ITEMS = [
  { id: "it-1", so_item_id: "lhf", item_code: "9058-1A(LHF)", item_group: "sofa", description: "Sofa", qty: 1 },
  { id: "it-2", so_item_id: "na", item_code: "9058-1NA", item_group: "sofa", description: "Sofa", qty: 1 },
];
const remainder = (soItemId: string, itemCode: string) => ({
  soItemId, docNo: SO, itemCode, itemGroup: "sofa", description: itemCode, uom: "UNIT",
  qty: 1, remaining: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0, variants: {},
});
let deliverable: unknown[] = [];

beforeEach(() => {
  deliverable = [remainder("cnr", "9058-CNR")];
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/delivery-orders-mfg/do-1") return { deliveryOrder: DOO, items: DO_ITEMS };
    if (url.startsWith("/delivery-orders-mfg/deliverable-so-lines")) return { lines: deliverable };
    if (url.startsWith("/staff/pickable")) return { staff: [] };
    if (url.startsWith("/localities")) return { localities: [] };
    return {};
  });
});

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scm/delivery-orders/new?edit=do-1"]}>
        <DeliveryOrderNewV2 />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const posts = () => authedFetch.mock.calls.filter(
  ([u, i]) => u === "/delivery-orders-mfg/do-1/items" && (i as RequestInit | undefined)?.method === "POST",
);
const pull = async () => {
  await waitFor(() => expect(screen.getByDisplayValue("BLK 682 B JURONG WEST CENTRAL 1")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "From Sales Order" }));
  await userEvent.click(screen.getByRole("button", { name: "Pull from SO" }));
};

describe("DeliveryOrderNewV2 edit — Pull from SO (HC-0146)", () => {
  it("does not touch the lines until the operator pulls", async () => {
    mount();
    await waitFor(() => expect(screen.getByDisplayValue("BLK 682 B JURONG WEST CENTRAL 1")).toBeTruthy());
    expect(authedFetch.mock.calls.some(([u]) => String(u).startsWith("/delivery-orders-mfg/deliverable-so-lines"))).toBe(false);
  });

  it("appends the undelivered corner piece and saves it as a new line on the same DO", async () => {
    mount();
    await pull();
    await waitFor(() => expect(screen.getByText("9058-CNR")).toBeTruthy());

    await userEvent.click(screen.getAllByRole("button", { name: "Save changes" })[0]);
    await waitFor(() => expect(posts().length).toBe(1));
    const body = JSON.parse(String((posts()[0][1] as RequestInit).body));
    expect(body).toMatchObject({ itemCode: "9058-CNR", soItemId: "cnr", qty: 1 });
  });

  it("skips SO lines the DO already carries (a DRAFT DO's own lines are still in the remainder)", async () => {
    deliverable = [remainder("na", "9058-1NA"), remainder("cnr", "9058-CNR")];
    mount();
    await pull();
    await waitFor(() => expect(screen.getByText("9058-CNR")).toBeTruthy());
    await userEvent.click(screen.getAllByRole("button", { name: "Save changes" })[0]);
    await waitFor(() => expect(posts().length).toBe(1));
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toMatchObject({ soItemId: "cnr" });
  });
});
