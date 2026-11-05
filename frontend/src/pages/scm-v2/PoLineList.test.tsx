/* Owner 2026-10-31: a group's PO lines listed below, layered by days late, a layer clicked narrows the list, empty layers hidden. */
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PoLineList, layerOf, poLineSheet, type LayerKey, type PoLine } from "./PoLineList";

const line = (n: number, daysLate: number | null): PoLine => ({
  poId: `id${n}`, poNumber: `PO-${n}`, poDate: "2026-10-01", supplier: "ACME", category: "MATTRESS", itemCode: `IT-${n}`,
  itemDesc: null, soDocNo: null, dueDate: daysLate == null ? null : "2026-10-20", openQty: 1, openSen: 100 * n, daysLate,
});
const lines = [line(1, 40), line(2, 10), line(3, 9), line(4, 2), line(5, -3), line(6, null)];

function Harness() {
  const [layer, setLayer] = useState<LayerKey | null>(null);
  return <MemoryRouter><PoLineList lines={lines} focusLabel={null} layer={layer} onLayer={setLayer} catLabel={(k) => k} onClearFocus={() => {}} /></MemoryRouter>;
}

describe("PoLineList", () => {
  it("days late fall in the layer whose range holds them", () => {
    expect([31, 30, 15, 14, 8, 7, 4, 3, 1, 0, -5].map((d) => layerOf({ daysLate: d })))
      .toEqual(["late30", "late15", "late15", "late8", "late8", "late4", "late4", "late1", "late1", "notDue", "notDue"]);
    expect(layerOf({ daysLate: null })).toBe("notDue");
  });
  it("hides empty layers, and a clicked layer lists only its lines", () => {
    render(<Harness />);
    expect(screen.queryByText("15–30 days late")).toBeNull();
    expect(screen.queryByText("4–7 days late")).toBeNull();
    expect(document.querySelectorAll("tbody tr").length).toBe(6);
    fireEvent.click(screen.getByText("8–14 days late"));
    expect([...document.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent).sort()).toEqual(["PO-2", "PO-3"]);
    fireEvent.click(screen.getByText("8–14 days late"));
    expect(document.querySelectorAll("tbody tr").length).toBe(6);
  });
  it("the Excel sheet carries ringgit, not sen", () => {
    expect(poLineSheet([line(3, 9)], (k) => k)[0]).toMatchObject({ PO: "PO-3", Amount: 3, "Days late": 9 });
  });
});
