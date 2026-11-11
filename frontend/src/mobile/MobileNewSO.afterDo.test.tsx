/* DEV-32 on the phone — "Edit SO after DO" in MobileNewSO, the SAME locks as the
 * desktop editor (pages/scm-v2/SalesOrderDetail.afterDo.test.tsx, same order
 * shape): HC-SO-013143, DELIVERED, every line on HC-DO-2610-011. Override takes a
 * reason (#5600); with `scm.so.edit_after_do` the customer details and the charge
 * lines reopen, the Ref No., the State and every product line stay frozen.
 *
 * Same harness as MobileNewSO.frozenLines.test.tsx: the screen MOUNTED in edit
 * mode under a real QueryClient, authedFetch faked.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detailBody, perms, overrideCalls } = vi.hoisted(() => ({
  detailBody: { current: null as unknown }, perms: { afterDo: true }, overrideCalls: [] as unknown[],
}));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string, init?: { method?: string }) => {
    if (path === "/mfg-sales-orders/validate") return Promise.resolve({ problems: [] });
    if (/\/mfg-sales-orders\/[^/?]+\/payments$/.test(path)) return Promise.resolve({ payments: [] });
    if (/\/mfg-sales-orders\/[^/?]+$/.test(path) && init?.method === "PATCH") return Promise.resolve({ ok: true, version: 4 });
    if (/\/mfg-sales-orders\/[^/?]+$/.test(path)) return Promise.resolve(detailBody.current);
    if (/\/items(\/|$)/.test(path) && init?.method) return Promise.resolve({ ok: true, item: { id: "new-1" } });
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/sales-order-queries")>()),
  /* The server kept the reason: the screen unlocks (the hook's own contract, failed-save-looks-ok.test.tsx). */
  useOverrideSoLock: () => ({ mutate: (v: unknown, o?: { onSuccess?: () => void }) => { overrideCalls.push(v); o?.onSuccess?.(); }, isPending: false }),
}));
vi.mock("./MobileSkuPicker", () => ({
  MobileSkuPicker: ({ serviceOnly, onPick }: { serviceOnly: boolean; onPick: (s: unknown) => void }) => (
    <button type="button" data-testid="sku-picker" data-service-only={String(serviceOnly)}
      onClick={() => onPick({ itemCode: "SVC-TRANSPORT", itemGroup: "service", name: "Transport", unitPriceSen: 5000, category: "SERVICE", defaultVariants: {} })}>
      pick
    </button>
  ),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => async () => "customer moved house" }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Logistics" }, can: (k: string) => k !== "scm.so.edit_after_do" || perms.afterDo }),
}));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

const DOC = "HC-SO-013143";
const DO1 = { id: "do-1", do_number: "HC-DO-2610-011", status: "LOADED", locked: false };

const header = {
  doc_no: DOC, status: "DELIVERED", so_date: "2026-08-05", debtor_name: "CHEW WEE LAU", phone: "+60162336952",
  email: "c@w.l", address1: "1 Jalan Satu", customer_state: "Putrajaya", city: "Putrajaya", postcode: "62000",
  customer_so_no: "HC14187", processing_date: "2026-08-06", customer_delivery_date: "2026-10-02", version: 3, currency: "MYR",
  has_children: true, downstream_fully_frozen: true, after_do_targets: [DO1], after_do_invoiced: false,
};
const line = (id: string, code: string, group: string) => ({
  id, doc_no: DOC, item_group: group, item_code: code, description: code, qty: 1, unit_price_sen: 5000, discount_sen: 0,
  variants: {}, remark: null, cancelled: false, line_delivery_date: "2026-10-02", line_delivery_date_overridden: false, downstream_frozen: true,
});
const ITEMS = [line("line-bed", "BF-QUEEN", "bedframe"), line("line-svc", "SVC-TRANSPORT", "service")];

beforeEach(() => { perms.afterDo = true; overrideCalls.length = 0; });
afterEach(() => { cleanup(); vi.mocked(authedFetch).mockClear(); });

const mount = async (so: Record<string, unknown> = header, items: unknown[] = ITEMS) => {
  detailBody.current = { salesOrder: so, items };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} onSaved={() => undefined} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByDisplayValue("CHEW WEE LAU")).toBeTruthy());
  return r;
};
const override = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Override" }));
  await screen.findByRole("button", { name: "Re-lock" });
};
const qtyInputs = () => document.querySelectorAll('input[aria-label="Qty"]'); // one per editable line card
const field = (value: string) => screen.getByDisplayValue(value) as HTMLInputElement;
const writes = () => vi.mocked(authedFetch).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method && (init as { method?: string }).method !== "GET")
  .map(([path, init]) => ({ path, method: (init as { method: string }).method, body: JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown> }));

describe("before Override, the delivered order is as locked as it was", () => {
  it("no notice, customer details shut, every line read-only, no Add line", async () => {
    await mount();
    expect(screen.getByTestId("so-lock-banner")).toBeTruthy();
    expect(screen.queryByTestId("so-after-do-notice")).toBeNull();
    expect(field("CHEW WEE LAU").disabled).toBe(true);
    expect(qtyInputs()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /add line/i })).toBeNull();
  });
});

describe("Logistics with the permission, after Override", () => {
  it("sends the typed reason with the override and names the DO the changes go to", async () => {
    await mount();
    await override();
    expect(overrideCalls).toEqual([{ docNo: DOC, status: "DELIVERED", reason: "customer moved house" }]);
    expect(screen.getByTestId("so-after-do-notice").textContent).toContain("HC-DO-2610-011");
  });

  it("reopens the customer details but not the Ref No.", async () => {
    await mount();
    await override();
    expect(field("CHEW WEE LAU").disabled).toBe(false);
    expect(field("1 Jalan Satu").disabled).toBe(false);
    expect(field("HC14187").disabled).toBe(true);
  });

  it("reopens the charge line as a card and leaves the bedframe frozen", async () => {
    const { container } = await mount();
    await override();
    expect(qtyInputs()).toHaveLength(1);
    const frozen = container.querySelectorAll('[data-frozen="true"]');
    expect(frozen).toHaveLength(1);
    expect(frozen[0]!.textContent).toContain("BF-QUEEN");
    expect(frozen[0]!.querySelectorAll("input, select, button, textarea")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /add line/i })).toBeTruthy();
  });

  it("saving a customer change sends the after-DO flag", async () => {
    await mount();
    await override();
    fireEvent.change(field("CHEW WEE LAU"), { target: { value: "CHEW WEE LAU (MR)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(writes().some((w) => w.method === "PATCH" && w.path === `/mfg-sales-orders/${DOC}` && w.body.afterDo === true && w.body.debtorName === "CHEW WEE LAU (MR)")).toBe(true));
    expect(writes().filter((w) => /\/items/.test(w.path))).toEqual([]);
  });

  it("a new line picks from charge SKUs only and asks the server to put it on the DO", async () => {
    await mount();
    await override();
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    fireEvent.click(screen.getByText(/Pick a product/));
    const picker = screen.getByTestId("sku-picker");
    expect(picker.dataset.serviceOnly).toBe("true");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(writes().some((w) => w.method === "POST" && /\/items$/.test(w.path))).toBe(true));
    const post = writes().find((w) => w.method === "POST" && /\/items$/.test(w.path))!;
    expect(post.body).toMatchObject({ itemCode: "SVC-TRANSPORT", afterDo: true });
    expect(post.body.targetDoId).toBeUndefined(); // one open DO: the server picks it
  });

  it("with two open DOs, offers the pick and sends it", async () => {
    await mount({ ...header, after_do_targets: [DO1, { ...DO1, id: "do-2", do_number: "HC-DO-2610-020" }] });
    await override();
    fireEvent.change(screen.getByLabelText("Delivery Order for new charge lines"), { target: { value: "do-2" } });
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    fireEvent.click(screen.getByText(/Pick a product/));
    fireEvent.click(screen.getByTestId("sku-picker"));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(writes().some((w) => w.method === "POST" && w.body.targetDoId === "do-2")).toBe(true));
  });

  it("an invoiced DO keeps the customer details shut and says why; charge lines stay open", async () => {
    await mount({ ...header, after_do_targets: [DO1, { ...DO1, id: "do-2", do_number: "HC-DO-2610-020", locked: true }] });
    await override();
    expect(screen.getByTestId("so-after-do-notice").textContent).toContain("HC-DO-2610-020 already has an invoice or return");
    expect(field("CHEW WEE LAU").disabled).toBe(true);
    expect(qtyInputs()).toHaveLength(1);
  });
});

describe("without the permission, Override changes nothing about the DO lock", () => {
  it("no notice, customer details shut, every line read-only", async () => {
    perms.afterDo = false;
    await mount();
    await override();
    expect(screen.queryByTestId("so-after-do-notice")).toBeNull();
    expect(field("CHEW WEE LAU").disabled).toBe(true);
    expect(qtyInputs()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /add line/i })).toBeNull();
  });
});
