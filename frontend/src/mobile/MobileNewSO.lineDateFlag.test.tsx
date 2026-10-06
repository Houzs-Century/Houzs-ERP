/* The phone sends lineDeliveryDateOverridden on every line it writes (owner
 * 2026-10-06, PR #4473): a date the header Delivery Date cascade copied goes out
 * as false, a date the operator typed as true. Left out, the server reads any
 * sent date as hand-set, and the line never follows a later header change.
 *
 * Same harness as MobileNewSO.fairPick.test.tsx: authedFetch faked, every call
 * recorded so the test reads the exact create body and line PATCH bodies. The
 * create is opened by Convert, the one way to seed picked lines without the
 * product picker.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (path === "/mfg-sales-orders/validate") return Promise.resolve({ problems: [] });
    if (path === `/mfg-sales-orders/${DOC}/payments`) return Promise.resolve({ payments: [] });
    if (path === `/mfg-sales-orders/${DOC}` && method === "GET") return Promise.resolve(detailBody.current);
    if (path === "/mfg-sales-orders" && method === "POST") return Promise.resolve({ docNo: "HC-SO-2610-002" });
    if (path.startsWith(`/mfg-sales-orders/${DOC}`) && method === "PATCH") return Promise.resolve({ ok: true, version: 4 });
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
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

afterEach(() => { cleanup(); vi.mocked(authedFetch).mockClear(); });

const DOC = "HC-SO-2610-001";

// Far-future dates: a passed Processing Date locks the lines.
const header = {
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-10-01", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  venue: null, processing_date: "2099-01-10", customer_delivery_date: "2099-01-20", version: 3, currency: "MYR",
  has_children: false, downstream_fully_frozen: false,
};
const item = (id: string, code: string) => ({
  id, doc_no: DOC, item_group: "mattress", item_code: code, description: `${code} name`, qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: "2099-01-20", line_delivery_date_overridden: false, downstream_frozen: false,
});

const mount = () => {
  detailBody.current = { salesOrder: header, items: [item("line-follow", "MT-QUEEN"), item("line-hand", "BF-QUEEN")] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} onSaved={() => undefined} />
    </QueryClientProvider>,
  );
};

const linePatch = (id: string) => {
  const call = vi.mocked(authedFetch).mock.calls
    .find(([p, init]) => p === `/mfg-sales-orders/${DOC}/items/${id}` && (init as { method?: string } | undefined)?.method === "PATCH");
  return call ? JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown> : undefined;
};

describe("phone SO editor — line date writes say whether the date was hand-set", () => {
  it("a header-copied date goes out as false, a typed one as true", async () => {
    const { container } = mount();
    const inputs = () => [...container.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    const dates = () => inputs().map((i) => i.value);
    // Header Processing, header Delivery, then one per line, in page order.
    await waitFor(() => expect(dates()).toEqual(["2099-01-10", "2099-01-20", "2099-01-20", "2099-01-20"]));
    fireEvent.change(inputs()[1]!, { target: { value: "2099-01-28" } });
    await waitFor(() => expect(dates()).toEqual(["2099-01-10", "2099-01-28", "2099-01-28", "2099-01-28"]));
    fireEvent.change(inputs()[3]!, { target: { value: "2099-01-25" } });
    await waitFor(() => expect(dates()).toEqual(["2099-01-10", "2099-01-28", "2099-01-28", "2099-01-25"]));

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(linePatch("line-hand")).toBeDefined());
    expect(linePatch("line-follow")).toMatchObject({ lineDeliveryDate: "2099-01-28", lineDeliveryDateOverridden: false });
    expect(linePatch("line-hand")).toMatchObject({ lineDeliveryDate: "2099-01-25", lineDeliveryDateOverridden: true });
  });
});

describe("phone New SO — the create body says whether each line date was hand-set", () => {
  it("a header-copied date goes out as false, a typed one as true", async () => {
    detailBody.current = { salesOrder: { ...header, status: "CANCELLED" }, items: [item("line-follow", "MT-QUEEN"), item("line-hand", "BF-QUEEN")] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MobileNewSO mode="new" openAddLine={false} onBack={() => undefined} onSaved={() => undefined}
          convertFrom={{ copyFrom: DOC, picks: [] }} />
      </QueryClientProvider>,
    );
    const inputs = () => [...container.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    const dates = () => inputs().map((i) => i.value);
    await waitFor(() => expect(dates()).toEqual(["", "", "2099-01-20", "2099-01-20"]));
    fireEvent.change(inputs()[0]!, { target: { value: "2099-01-10" } });
    fireEvent.change(inputs()[1]!, { target: { value: "2099-01-28" } });
    await waitFor(() => expect(dates()).toEqual(["2099-01-10", "2099-01-28", "2099-01-28", "2099-01-28"]));
    fireEvent.change(inputs()[3]!, { target: { value: "2099-01-25" } });
    await waitFor(() => expect(dates()).toEqual(["2099-01-10", "2099-01-28", "2099-01-28", "2099-01-25"]));

    fireEvent.click(screen.getByRole("button", { name: "Create Sales Order" }));

    const createBody = () => {
      const call = vi.mocked(authedFetch).mock.calls.find(([p, init]) => p === "/mfg-sales-orders" && (init as { method?: string } | undefined)?.method === "POST");
      return call ? JSON.parse(String((call[1] as { body: string }).body)) as { items: Record<string, unknown>[] } : undefined;
    };
    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()!.items).toMatchObject([
      { itemCode: "MT-QUEEN", lineDeliveryDate: "2099-01-28", lineDeliveryDateOverridden: false },
      { itemCode: "BF-QUEEN", lineDeliveryDate: "2099-01-25", lineDeliveryDateOverridden: true },
    ]);
  });
});
