/* Convert on the phone (docs/bugs/0933): the New SO screen opened from a
 * cancelled order's money panel carries that order's customer and lines and
 * one "Convert from cancelled SO" row per pick, the pick already made and the
 * amount already there. Same harness as MobileNewSO.frozenLines.test.tsx —
 * the screen is MOUNTED under a real QueryClient with authedFetch faked: the
 * cancelled order's detail and the customer's cancelled-with-money list
 * answer, every other request stays pending.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (/\/mfg-sales-orders\/with-money/.test(path)) {
      return Promise.resolve({ orders: [{ docNo: OLD, customer: "Ada", status: "CANCELLED", cancelledOn: "2026-08-01", remainingSen: 336_500, bookedSen: 336_500, movableSen: 336_500, keepSen: 0 }], totalRemainingSen: 336_500 });
    }
    if (/\/mfg-sales-orders\/[^/?]+$/.test(path)) return Promise.resolve(detailBody.current);
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";
import { CONVERT_LABEL } from "../vendor/scm/lib/so-money-queries";

afterEach(cleanup);

const OLD = "2990-SO-2607-024";

const cancelledOrder = {
  doc_no: OLD, status: "CANCELLED", so_date: "2026-07-01", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  processing_date: null, customer_delivery_date: "2026-08-20", version: 2, currency: "MYR",
  has_children: false, downstream_fully_frozen: false,
};
const item = {
  id: "line-1", doc_no: OLD, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name", qty: 1,
  unit_price_sen: 336_500, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: "2026-08-20", line_delivery_date_overridden: false, downstream_frozen: false,
  photo_urls: ["so/old/photo-1.jpg"],
};

describe("phone New SO opened by Convert", () => {
  it("copies the cancelled order's customer and lines (fresh, without its photos) and seeds one converted row per pick", async () => {
    detailBody.current = { salesOrder: cancelledOrder, items: [item] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MobileNewSO mode="new" openAddLine={false} onBack={() => undefined}
          convertFrom={{ copyFrom: OLD, picks: [{ docNo: OLD, amountSen: 336_500 }] }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    expect(container.textContent).toContain("MT-QUEEN");
    /* The converted row: its method chosen, its source picked, its amount what was picked. */
    const source = screen.getByLabelText("Cancelled order") as HTMLSelectElement;
    expect(source.value).toBe(OLD);
    const methods = Array.from(container.querySelectorAll("select")).filter((s) => Array.from(s.options).some((o) => o.value === CONVERT_LABEL));
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0]!.value).toBe(CONVERT_LABEL);
    expect(screen.getByDisplayValue("3365.00")).toBeTruthy();
  });
});
