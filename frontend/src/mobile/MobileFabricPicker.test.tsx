/* THE PHONE'S FABRIC SHEET OFFERS ONLY WHAT THE SAVE ACCEPTS. docs/bugs/0889.
 *
 * The sheet listed every search hit, while the save gate refuses a colour whose
 * Model does not enable it (colour id or series in allowed_options.fabrics), so
 * a salesperson could pick a fabric and then watch the save fail with
 * variant_not_allowed. The desktop combobox already filtered. The sheet now asks
 * the same shared module the gate reads; these cases are the gate's own.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { search, allowed } = vi.hoisted(() => ({ search: vi.fn(), allowed: vi.fn() }));
vi.mock("../vendor/scm/lib/fabric-queries", () => ({ useFabricColoursSearch: search }));
vi.mock("../vendor/scm/lib/mfg-products-queries", () => ({ useModelAllowedOptionsByCode: allowed }));
vi.mock("../vendor/scm/lib/hooks", () => ({ useDebouncedValue: (v: string) => v }));

import { MobileFabricPicker } from "./MobileFabricPicker";

const colour = (colourId: string, fabricId: string) => ({ colourId, fabricId, label: null, swatchHex: null });
const HITS = [
  colour("BO315-23", "BO315"),     // series enabled
  colour("CG-002-11", "CG-002"),   // colour enabled, series not
  colour("TARONI-05", "TARONI"),   // pool entry carries a trailing space
  colour("GD2502-11", "GD2502"),   // neither enabled
];

afterEach(cleanup);
beforeEach(() => {
  search.mockReset();
  allowed.mockReset();
  search.mockReturnValue({ data: HITS, isFetching: false });
});

function open(pool: string[] | null) {
  allowed.mockReturnValue({ data: pool === null ? null : { fabrics: pool } });
  render(
    <MobileFabricPicker itemCode="5530-1A" fabricSeries={new Map()} current="" onPick={() => {}} onClose={() => {}} />,
  );
  fireEvent.change(screen.getByPlaceholderText(/fabric code or colour/i), { target: { value: "fab" } });
}

describe("MobileFabricPicker — the Model's fabric pool", () => {
  it("lists a colour whose series or colour is enabled, and hides one that is not", () => {
    open(["BO315", "CG-002-11", "TARONI "]);
    expect(screen.queryByText("BO315-23")).not.toBeNull();
    expect(screen.queryByText("CG-002-11")).not.toBeNull();
    expect(screen.queryByText("TARONI-05")).not.toBeNull();
    expect(screen.queryByText("GD2502-11")).toBeNull();
  });

  it("asks for the pool of the line's own item code", () => {
    open(["BO315"]);
    expect(allowed).toHaveBeenCalledWith("5530-1A");
  });

  it("an empty pool, or a Model with none, restricts nothing", () => {
    open([]);
    for (const c of HITS) expect(screen.queryByText(c.colourId)).not.toBeNull();
    cleanup();
    open(null);
    for (const c of HITS) expect(screen.queryByText(c.colourId)).not.toBeNull();
  });

  it("says the search matched but the Model enables none, rather than 'no match'", () => {
    open(["ZZZ"]);
    expect(screen.queryByText(/none is enabled for this model/i)).not.toBeNull();
    expect(screen.queryByText(/No fabrics match/i)).toBeNull();
  });
});

/* docs/bugs/0893 (the fabric-search entry): the server applies the Model's pool
   BEFORE its 50-row cap only when the search names the item, so the sheet must
   send its line's SKU with every search. */
describe("the phone fabric search names its line's item", () => {
  it("asks the server with the item code, not a bare search", () => {
    open(["BO315"]);
    const calls = search.mock.calls as Array<[string, { enabled: boolean; itemCode: string | null }]>;
    const last = calls[calls.length - 1];
    expect(last[0]).toBe("fab");
    expect(last[1]).toEqual({ enabled: true, itemCode: "5530-1A" });
  });
});
