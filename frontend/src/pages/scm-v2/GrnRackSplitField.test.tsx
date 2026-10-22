/* Sim, 2026-10-20: on the GRN edit page, picking a rack then pressing Add was
 * "double work", and a pick left without Add saved nothing (HC-GRN-2610-155 /
 * 156 were posted with no rack). The first rack of an unplaced line saves on
 * the pick; only a second rack (a split) asks for its qty. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ put: vi.fn(), rows: [] as Array<{ grnItemId: string; rackId: string; qty: number }> }));
vi.mock("../../vendor/scm/lib/grn-queries", () => ({
  useGrnItemRacks: () => ({ data: h.rows, isLoading: false }),
  useSetGrnLineRacks: () => ({ mutate: h.put, isPending: false }),
}));
vi.mock("../../vendor/scm/components/SearchableSelect", () => ({
  SearchableSelect: ({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; ariaLabel: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" />
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import { GrnRackSplitField } from "./GrnRackSplitField";

afterEach(cleanup);
beforeEach(() => { h.put.mockReset(); h.rows = []; });

const field = () => render(
  <GrnRackSplitField grnId="G1" itemId="I1" lineRackId={null} qtyAccepted={2}
    rackOptions={[{ value: "R17", label: "Rack R17.2" }, { value: "R11", label: "Rack R11.2" }]}
    rackLabelById={new Map([["R17", "Rack R17.2"], ["R11", "Rack R11.2"]])} />,
);

describe("GrnRackSplitField", () => {
  it("the first rack picked takes the whole line at once, no Add", () => {
    field();
    fireEvent.change(screen.getByLabelText("Add a rack"), { target: { value: "R17" } });
    expect(h.put.mock.calls[0][0]).toEqual({ grnId: "G1", itemId: "I1", racks: [{ rackId: "R17", qty: 2 }] });
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("a second rack still asks for its qty", () => {
    h.rows = [{ grnItemId: "I1", rackId: "R17", qty: 2 }];
    field();
    fireEvent.change(screen.getByLabelText("Add a rack"), { target: { value: "R11" } });
    expect(h.put).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });
});
