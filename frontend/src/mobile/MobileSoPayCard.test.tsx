/* The phone payment row moved out of MobileNewSO.tsx (size ceiling) unchanged.
 * Pins what it did there: the method decides the sub-fields, a row with money
 * and no slip says the slip is required, edits and the remove cross reach the
 * owner, and Convert shows its source pick. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn(() => new Promise(() => undefined)), // the dropdowns fall back to their seed lists
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => false }) }));

import { PayCard, type Payment } from "./MobileSoPayCard";
import { SLIP_REQUIRED_REASON } from "../vendor/scm/lib/payment-slip-gate";
import { CONVERT_LABEL } from "../vendor/scm/lib/so-money-queries";

afterEach(cleanup);

const pay = (patch: Partial<Payment> = {}): Payment => ({
  key: "p1", idempotencyKey: "k1", method: "Cash", date: "2026-11-11", amount: "0.00", account: "", approval: "",
  collectedBy: "", bank: "", plan: "", online: "", slipName: "", slipSession: "", slipPhase: "", ...patch,
});
const mount = (p: Payment, onChange = vi.fn(), onRemove = vi.fn()) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PayCard pay={p} staff={[{ id: "s1", name: "Aina" }]} convertSources={[]} onChange={onChange} onRemove={onRemove} />
    </QueryClientProvider>,
  );
  return { onChange, onRemove };
};

describe("phone payment row (moved out of MobileNewSO)", () => {
  it("Cash: no bank / plan / sub-type", () => {
    mount(pay());
    expect(screen.queryByText("Bank *")).toBeNull();
    expect(screen.queryByText("Sub-type *")).toBeNull();
  });

  it("Merchant asks for bank and plan; Online for its sub-type", () => {
    mount(pay({ method: "Merchant" }));
    expect(screen.getByText("Bank *")).toBeTruthy();
    expect(screen.getByText("Plan *")).toBeTruthy();
    cleanup();
    mount(pay({ method: "Online" }));
    expect(screen.getByText("Sub-type *")).toBeTruthy();
  });

  it("money without a slip says the slip is required; an attached slip clears it", () => {
    mount(pay({ amount: "100.00" }));
    expect(screen.getByText(SLIP_REQUIRED_REASON)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload slip" })).toBeTruthy();
    cleanup();
    mount(pay({ amount: "100.00", slipSession: "sess-1", slipPhase: "done", slipName: "slip.jpg" }));
    expect(screen.queryByText(SLIP_REQUIRED_REASON)).toBeNull();
    expect(screen.getByText("Slip attached ✓")).toBeTruthy();
  });

  it("an amount edit and the remove cross reach the owner", () => {
    const { onChange, onRemove } = mount(pay());
    fireEvent.change(screen.getByDisplayValue("0.00"), { target: { value: "250" } });
    expect(onChange).toHaveBeenCalledWith({ amount: "250" });
    fireEvent.click(screen.getByText("✕"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("Convert shows the source pick and drops the slip requirement from the label", () => {
    mount(pay({ method: CONVERT_LABEL }));
    expect(screen.getByLabelText("Cancelled order")).toBeTruthy();
    expect(screen.getByText("Slip")).toBeTruthy();
  });
});
