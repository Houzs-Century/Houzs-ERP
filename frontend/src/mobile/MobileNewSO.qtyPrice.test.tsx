/* DEV-62 (Adrian): on the phone line card the qty steps with − / + and the
 * Unit Price opens the decimal keypad instead of the letter keyboard. Mounted
 * the same way as MobileNewSO.frozenLines.test.tsx. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";

afterEach(cleanup);

const DOC = "HC-SO-2610-001";

const mount = () => {
  detailBody.current = {
    salesOrder: {
      doc_no: DOC, status: "CONFIRMED", so_date: "2026-10-01", debtor_name: "Ada", phone: "+60123456789",
      email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
      processing_date: null, customer_delivery_date: "2026-10-20", version: 1, currency: "MYR",
      has_children: false, downstream_fully_frozen: false,
    },
    items: [{
      id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name", qty: 1,
      unit_price_sen: 239900, discount_sen: 0, variants: {}, remark: null, cancelled: false,
      line_delivery_date: "2026-10-20", line_delivery_date_overridden: false, downstream_frozen: false,
    }],
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} />
    </QueryClientProvider>,
  );
};

const qtyBox = (c: HTMLElement) => c.querySelector(".qty-step input") as HTMLInputElement | null;

describe("phone SO line card — qty stepper, typed price (DEV-62)", () => {
  it("− / + step the qty and − stops at 1", async () => {
    const { container } = mount();
    await waitFor(() => expect(qtyBox(container)).not.toBeNull(), { timeout: 4000 });
    const qty = qtyBox(container)!;
    const dec = screen.getByLabelText("Decrease qty") as HTMLButtonElement;
    expect(qty.value).toBe("1");
    expect(dec.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Increase qty"));
    fireEvent.click(screen.getByLabelText("Increase qty"));
    expect(qtyBox(container)!.value).toBe("3");
    fireEvent.click(dec);
    expect(qtyBox(container)!.value).toBe("2");
    fireEvent.change(qtyBox(container)!, { target: { value: "12" } });
    expect(qtyBox(container)!.value).toBe("12");
  });

  it("the Unit Price opens the decimal keypad", async () => {
    const { container } = mount();
    await waitFor(() => expect(qtyBox(container)).not.toBeNull(), { timeout: 4000 });
    const price = container.querySelector("input.fld-i.money") as HTMLInputElement;
    expect(price.value).toMatch(/2,?399\.00/);
    expect(price.inputMode).toBe("decimal");
  });
});
