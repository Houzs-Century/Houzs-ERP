/* A partly delivered Sales Order in the PHONE editor (owner 2026-09-15) — the
 * same rule as SalesOrderDetail.frozenLines.test.tsx, on the other surface.
 *
 * MobileNewSO is MOUNTED in edit mode under a real QueryClient. It loads the
 * order through authedFetch itself, so that one module is faked: the detail and
 * the payments ledger answer, every other request stays pending.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (/\/mfg-sales-orders\/[^/?]+\/payments$/.test(path)) return Promise.resolve({ payments: [] });
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

afterEach(cleanup);

const DOC = "HC-SO-2609-001";

const header = {
  doc_no: DOC, status: "READY_TO_SHIP", so_date: "2026-09-01", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  processing_date: null, customer_delivery_date: "2026-09-20", version: 3, currency: "MYR",
  has_children: true, downstream_fully_frozen: false,
};

const item = (id: string, code: string, frozen: boolean) => ({
  id, doc_no: DOC, item_group: "mattress", item_code: code, description: `${code} name`, qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: "2026-09-20", line_delivery_date_overridden: false, downstream_frozen: frozen,
});

const mount = (so: Record<string, unknown>, items: unknown[]) => {
  detailBody.current = { salesOrder: so, items };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} />
    </QueryClientProvider>,
  );
};

describe("phone SO editor — a partly delivered order", () => {
  it("renders the delivered line greyed with nothing to press, and the sibling as an editable card", async () => {
    const { container } = mount(header, [item("line-delivered", "BF-QUEEN", true), item("line-open", "MT-QUEEN", false)]);
    await waitFor(() => expect(container.querySelector('[data-frozen="true"]')).not.toBeNull());
    const frozen = container.querySelector('[data-frozen="true"]') as HTMLElement;
    expect(frozen.textContent).toContain("BF-QUEEN");
    expect(frozen.textContent).toContain("On a Delivery Order / Invoice");
    expect(frozen.style.filter).toBe("grayscale(1)");
    expect(frozen.querySelectorAll("input, select, button, textarea")).toHaveLength(0);
    expect(frozen.textContent).not.toContain("MT-QUEEN");
    /* The sibling is a real line card (it carries controls), and a line can still be added. */
    expect(screen.getByRole("button", { name: /add line/i })).toBeTruthy();
    expect(container.querySelectorAll('[data-frozen="true"]')).toHaveLength(1);
  });

  it("freezes the customer fields a delivery order snapshots", async () => {
    mount(header, [item("line-delivered", "BF-QUEEN", true), item("line-open", "MT-QUEEN", false)]);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    expect((screen.getByDisplayValue("Ada") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("1 Jalan") as HTMLInputElement).disabled).toBe(true);
  });

  it("an order whose every line is on a DO or invoice shows every line read-only, as before", async () => {
    const { container } = mount({ ...header, downstream_fully_frozen: true }, [item("line-delivered", "BF-QUEEN", true)]);
    await waitFor(() => expect(screen.getByText(/line items can no longer be changed/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /add line/i })).toBeNull();
    expect(container.querySelector('[data-frozen="true"]')).toBeNull();
  });
});
