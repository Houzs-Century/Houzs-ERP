/* DEV-73 (Sim, 13 Oct 2026): the supplier date dialog must show what is already
 * recorded, refuse a slot every ticked PO has filled, and default to the next
 * empty slot so a recorded Date 2 is never typed over. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoHeaderRow } from "../../vendor/scm/lib/suppliers-queries";

const h = vi.hoisted(() => ({ authed: vi.fn() }));
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({
  authedFetch: (...a: unknown[]) => h.authed(...a),
  humanApiError: (_s: number, b: string) => b,
}));

import { PoBulkSupplierDateModal } from "./PoBulkSupplierDateModal";

const po = (id: string, poNumber: string, d2: string | null, d3: string | null) =>
  ({ id, po_number: poNumber, expected_at: "2026-10-01", supplier_delivery_date_2: d2, supplier_delivery_date_3: d3, supplier_delivery_date_4: null }) as PoHeaderRow;

afterEach(cleanup);
beforeEach(() => { h.authed.mockReset(); });

describe("PoBulkSupplierDateModal", () => {
  const pos = [po("a", "PO2609-141", "2026-10-14", null), po("b", "PO2609-142", "2026-10-15", "2026-10-20")];
  const renderIt = () =>
    render(<PoBulkSupplierDateModal open poIds={["a", "b"]} pos={pos} onClose={() => {}} onDone={() => {}} />);

  it("shows each ticked PO's recorded dates and disables a slot filled on all of them", () => {
    renderIt();
    expect(screen.getByText("PO2609-141")).toBeTruthy();
    expect(screen.getByText("PO2609-142")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next empty date" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Supplier Date 2" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Supplier Date 3" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends slot next by default", async () => {
    h.authed.mockResolvedValue({ slot: "next", date: "2026-10-30", applyToLines: true, updated: [], skipped: [] });
    const { container } = renderIt();
    // DateField's hidden native picker, the input that commits an ISO value.
    fireEvent.change(container.ownerDocument.querySelector('input[tabindex="-1"]')!, { target: { value: "2026-10-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 POs" }));
    await waitFor(() => expect(h.authed).toHaveBeenCalled());
    expect(JSON.parse(h.authed.mock.calls[0]![1].body)).toMatchObject({ slot: "next", poIds: ["a", "b"] });
  });
});
