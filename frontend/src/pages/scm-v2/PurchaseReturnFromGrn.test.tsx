/* HC-0135: Purchase Return "Transfer from Goods Received" — choose one posted
 * note, tick only the lines going back, carry just those to the New form.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLink } from "../../lib/convertScope";

const h = vi.hoisted(() => ({
  grnsPaged: vi.fn(),
  grnDetail: vi.fn(),
  write: vi.fn((_key: string, _payload: unknown) => true),
}));

vi.mock("../../vendor/scm/lib/grn-queries", () => ({
  useGrnsPaged: h.grnsPaged,
  useGrnDetail: h.grnDetail,
}));
vi.mock("../../lib/scmHandoffStorage", () => ({ writeScmHandoff: h.write }));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));

import { PurchaseReturnFromGrn } from "./PurchaseReturnFromGrn";

const loaded = <T,>(data: T) => ({ data, isLoading: false, isError: false });

const header = (id: string, grnNumber: string) => ({
  id, grn_number: grnNumber, received_at: "2026-09-22", delivery_note_ref: "DO-001511",
  fully_returned: false, supplier: { name: "CARRES SDN. BHD." }, purchase_order: { po_number: "HC-PO-2609-035" },
  total_sen: 95600, currency: "MYR",
});
const line = (id: string, code: string, accepted: number, returned: number) => ({
  id, item_code: code, material_name: `${code} MATTRESS`, item_group: "mattress", description: null,
  variants: null, qty_accepted: accepted, returned_qty: returned, unit_price_sen: 95600,
});
const LINES = [
  line("a", "M1401F MATT (K)", 2, 0),
  line("b", "M1401F MATT (Q)", 1, 0),
  line("c", "M1401F MATT (S)", 1, 1),
];

function Landed() {
  const loc = useLocation();
  return <div data-testid="landed">{loc.pathname + loc.search}</div>;
}
const at = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/scm/purchase-returns/from-grn" element={<PurchaseReturnFromGrn />} />
        <Route path="/scm/purchase-returns/new" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  h.grnsPaged.mockReturnValue(loaded({ grns: [header("g-1", "HC-GRN-2609-136"), header("g-2", "HC-GRN-2609-140")] }));
  h.grnDetail.mockImplementation((id: string | null) =>
    id ? loaded({ grn: header(id, "HC-GRN-2609-136"), items: LINES }) : { data: undefined, isLoading: false, isError: false });
  h.write.mockClear();
});
afterEach(cleanup);

const box = (code: string) => screen.getByRole("checkbox", { name: `Pick ${code}` }) as HTMLInputElement;

describe("Purchase Return: Transfer from Goods Received (HC-0135)", () => {
  it("lists posted notes, and clicking one opens its lines", () => {
    at("/scm/purchase-returns/from-grn");
    expect(h.grnsPaged).toHaveBeenCalledWith(expect.objectContaining({ status: "posted" }));
    fireEvent.click(screen.getByText("HC-GRN-2609-136"));
    expect(box("M1401F MATT (K)")).toBeTruthy();
  });

  it("opens scoped from the GRN's own button with no line ticked", () => {
    at(convertToLink("grnToPr", "g-1"));
    expect(box("M1401F MATT (K)").checked).toBe(false);
    expect(box("M1401F MATT (Q)").checked).toBe(false);
    expect(box("M1401F MATT (S)").disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Tick the lines to return/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("carries only the ticked line, at the qty typed, to the New form", () => {
    at(convertToLink("grnToPr", "g-1"));
    fireEvent.click(box("M1401F MATT (K)"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Qty to return for M1401F MATT (K)" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue with 1 line/ }));
    expect(h.write).toHaveBeenCalledWith("prFromGrnPicks", { grnId: "g-1", picks: [{ grnItemId: "a", qty: 1 }] });
    expect(screen.getByTestId("landed").textContent).toBe("/scm/purchase-returns/new?fromPicks=1");
  });

  it("caps the typed qty at what the line can still return", () => {
    at(convertToLink("grnToPr", "g-1"));
    fireEvent.click(box("M1401F MATT (Q)"));
    const qty = screen.getByRole("spinbutton", { name: "Qty to return for M1401F MATT (Q)" }) as HTMLInputElement;
    fireEvent.change(qty, { target: { value: "5" } });
    expect(qty.value).toBe("1");
  });
});
