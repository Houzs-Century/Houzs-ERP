/* BUG-101 on the phone editor — the same rule as
 * SalesOrderDetail.processingPoLock.test.tsx: a live PO freezes the Processing
 * Date, the Delivery Date stays open.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody, auth } = vi.hoisted(() => ({ detailBody: { current: null as unknown }, auth: { override: false } }));

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
/* Every grant except the PO exception, unless a test turns it on. */
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Desk" }, can: (p: string) => p !== "scm.so.override_po_processing_date" || auth.override }),
}));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";

afterEach(() => { cleanup(); auth.override = false; });

const DOC = "HC-SO-2609-395";

const header = {
  doc_no: DOC, status: "IN_PRODUCTION", so_date: "2026-09-01", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  processing_date: "2027-01-10", customer_delivery_date: "2027-01-20", version: 3, currency: "MYR",
  has_children: false, downstream_fully_frozen: false,
};

const item = {
  id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name", qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: "2027-01-20", line_delivery_date_overridden: false, downstream_frozen: false,
};

const mount = (so: Record<string, unknown>) => {
  detailBody.current = { salesOrder: so, items: [item] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} />
    </QueryClientProvider>,
  );
};

describe("phone SO editor — Processing Date under a live PO", () => {
  it("freezes the Processing Date and keeps the Delivery Date open", async () => {
    mount({ ...header, processing_date_po_locked: true });
    await waitFor(() => expect(screen.getByDisplayValue("2027/01/10")).toBeTruthy());
    expect((screen.getByDisplayValue("2027/01/10") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getAllByDisplayValue("2027/01/20")[0] as HTMLInputElement).disabled).toBe(false); // header first, the line card after
    expect(screen.getByText(/only a purchaser can change this date/i)).toBeTruthy();
  });

  it("a holder of the PO exception can still change it", async () => {
    auth.override = true;
    mount({ ...header, processing_date_po_locked: true });
    await waitFor(() => expect(screen.getByDisplayValue("2027/01/10")).toBeTruthy());
    expect((screen.getByDisplayValue("2027/01/10") as HTMLInputElement).disabled).toBe(false);
  });

  it("with no PO, the Processing Date is editable as before", async () => {
    mount({ ...header, processing_date_po_locked: false });
    await waitFor(() => expect(screen.getByDisplayValue("2027/01/10")).toBeTruthy());
    expect((screen.getByDisplayValue("2027/01/10") as HTMLInputElement).disabled).toBe(false);
  });
});
