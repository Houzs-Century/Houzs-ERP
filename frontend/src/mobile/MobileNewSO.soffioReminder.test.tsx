/* Creating an order on the phone with a SOFFIO (8030-) line asks the rep to
 * check the code first: a fully extend sofa is SOFFIO 2.0 (5562-). "Go back"
 * sends nothing; "Yes, it is SOFFIO" creates the order; no 8030 line, no ask.
 * Same harness as MobileNewSO.copyAsNew.test.tsx (the copy seeds the form).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody, ask } = vi.hoisted(() => ({ detailBody: { current: null as unknown }, ask: vi.fn() }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string, init?: { method?: string }) => {
    if (path === "/mfg-sales-orders/validate") return Promise.resolve({ problems: [] });
    if (path === "/mfg-sales-orders" && init?.method === "POST") return Promise.resolve({ docNo: "HC-SO-NEW-1" });
    if (/\/mfg-sales-orders\/[^/?]+$/.test(path)) return Promise.resolve(detailBody.current);
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => ask, usePrompt: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

afterEach(() => { cleanup(); ask.mockReset(); vi.mocked(authedFetch).mockClear(); });

const SRC = "HC-SO-2611-001";
const source = {
  doc_no: SRC, status: "CONFIRMED", so_date: "2026-11-01", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  processing_date: null, customer_delivery_date: null, version: 2, currency: "MYR", salesperson_id: null,
  has_children: false, downstream_fully_frozen: false,
};
const item = (code: string, group: string) => ({
  id: `l-${code}`, doc_no: SRC, item_group: group, item_code: code, description: `${code} name`, qty: 1,
  unit_price_sen: 100_000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: null, downstream_frozen: false,
});

const creates = () => vi.mocked(authedFetch).mock.calls
  .filter(([p, init]) => p === "/mfg-sales-orders" && (init as { method?: string } | undefined)?.method === "POST");

const mountWith = async (items: unknown[], code: string) => {
  detailBody.current = { salesOrder: source, items };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="new" openAddLine={false} onBack={() => undefined} convertFrom={{ copyFrom: SRC, picks: [] }} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.container.textContent).toContain(code));
  return view;
};

describe("phone New SO: SOFFIO code reminder", () => {
  it("asks before creating an order with an 8030 line; Go back sends nothing", async () => {
    ask.mockResolvedValue(false);
    await mountWith([item("8030-1A(LHF)", "sofa")], "8030-1A(LHF)");
    fireEvent.click(screen.getByRole("button", { name: "Create Sales Order" }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0]).toMatchObject({ title: "Check the SOFFIO code", confirmLabel: "Yes, it is SOFFIO", cancelLabel: "Go back" });
    expect(String(ask.mock.calls[0][0].body)).toContain("8030-1A(LHF)");
    await new Promise((r) => setTimeout(r, 0));
    expect(creates()).toHaveLength(0);
  });

  it("creates the order once the rep says it is SOFFIO", async () => {
    ask.mockResolvedValue(true);
    await mountWith([item("8030-1A(LHF)", "sofa")], "8030-1A(LHF)");
    fireEvent.click(screen.getByRole("button", { name: "Create Sales Order" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the order has no 8030 line", async () => {
    await mountWith([item("MT-QUEEN", "mattress")], "MT-QUEEN");
    fireEvent.click(screen.getByRole("button", { name: "Create Sales Order" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask on Save draft", async () => {
    await mountWith([item("8030-1A(LHF)", "sofa")], "8030-1A(LHF)");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(ask).not.toHaveBeenCalled();
  });
});
