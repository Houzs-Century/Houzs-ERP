import { describe, expect, test } from "vitest";
import {
  planAllocationCreate,
  planAllocationQtyUpdate,
  resequenceAfterDelete,
  allocationSubNumber,
} from "../src/scm/lib/po-allocations";

// The consolidated-PO split (mig 0235): one PO line serves several customers
// plus stock, as 1-based sub-numbered slices. These pin the write-path rules
// the routes enforce; the DB triggers carry the same invariant against
// concurrent writers (proven in tests-pg/poItemAllocations.pg.test.ts).

const alloc = (id: string, seq: number, qty: number, so: string | null = null) =>
  ({ id, seq, qty, so_item_id: so });

describe("planAllocationCreate — qty cap + dense seq", () => {
  test("the owner's live case: qty-5 line splits SO x1 + SO x1 + stock x3", () => {
    const first = planAllocationCreate(5, [], 1);
    expect(first).toEqual({ refusal: null, qty: 1, seq: 1 });
    const second = planAllocationCreate(5, [alloc("a", 1, 1)], 1);
    expect(second).toEqual({ refusal: null, qty: 1, seq: 2 });
    const stock = planAllocationCreate(5, [alloc("a", 1, 1), alloc("b", 2, 1)], 3);
    expect(stock).toEqual({ refusal: null, qty: 3, seq: 3 });
  });

  test("the sum may reach the line qty exactly, never exceed it", () => {
    const exact = planAllocationCreate(5, [alloc("a", 1, 2)], 3);
    expect(exact.refusal).toBeNull();
    const over = planAllocationCreate(5, [alloc("a", 1, 2)], 4);
    expect(over.refusal?.error).toBe("allocation_exceeds_line_qty");
    // The refusal carries the numbers so the UI can state the room left.
    expect(over.refusal?.lineQty).toBe(5);
    expect(over.refusal?.allocatedQty).toBe(2);
    expect(over.refusal?.remainingQty).toBe(3);
  });

  test("qty must be a positive integer — zero, negative, fraction, junk all refuse", () => {
    for (const bad of [0, -1, 1.5, "x", NaN, null, undefined]) {
      expect(planAllocationCreate(5, [], bad).refusal?.error).toBe("invalid_qty");
    }
  });

  test("a fully-allocated line has no room at all", () => {
    const plan = planAllocationCreate(2, [alloc("a", 1, 1), alloc("b", 2, 1)], 1);
    expect(plan.refusal?.error).toBe("allocation_exceeds_line_qty");
    expect(plan.refusal?.remainingQty).toBe(0);
  });
});

describe("planAllocationQtyUpdate — cap excludes the row being edited", () => {
  const existing = [alloc("a", 1, 2, "so-1"), alloc("b", 2, 3)];

  test("growing a slice within the freed room is fine (its own qty is not counted twice)", () => {
    // Line qty 5, a=2 b=3. Editing a to 2 (same) or shrinking b to 1 both fine.
    expect(planAllocationQtyUpdate(5, existing, "a", 2).refusal).toBeNull();
    const shrink = planAllocationQtyUpdate(5, existing, "b", 1);
    expect(shrink).toEqual({ refusal: null, qty: 1 });
  });

  test("growing a slice past the room the OTHERS leave refuses", () => {
    const over = planAllocationQtyUpdate(5, existing, "a", 3); // others sum 3 -> 3+3 > 5
    expect(over.refusal?.error).toBe("allocation_exceeds_line_qty");
  });

  test("absent qty keeps the stored value (partial-PATCH contract)", () => {
    const keep = planAllocationQtyUpdate(5, existing, "a", undefined);
    expect(keep).toEqual({ refusal: null, qty: 2 });
  });

  test("an unknown allocation id refuses as not-found", () => {
    expect(planAllocationQtyUpdate(5, existing, "ghost", 1).refusal?.error).toBe("allocation_not_found");
  });
});

describe("resequenceAfterDelete — survivors close to dense 1..n, moves stay collision-free", () => {
  test("deleting the middle slice moves only the ones after it, each DOWN into a freed slot", () => {
    const rows = [alloc("a", 1, 1), alloc("b", 2, 1), alloc("c", 3, 3)];
    expect(resequenceAfterDelete(rows, "b")).toEqual([{ id: "c", seq: 2 }]);
  });

  test("deleting the first moves everything down, in ascending order", () => {
    const rows = [alloc("a", 1, 1), alloc("b", 2, 1), alloc("c", 3, 3)];
    expect(resequenceAfterDelete(rows, "a")).toEqual([
      { id: "b", seq: 1 },
      { id: "c", seq: 2 },
    ]);
  });

  test("deleting the last moves nothing", () => {
    const rows = [alloc("a", 1, 1), alloc("b", 2, 1)];
    expect(resequenceAfterDelete(rows, "b")).toEqual([]);
  });
});

describe("allocationSubNumber — the printable PO-xxxx-yy-0N", () => {
  test("pads to two digits; a null PO number degrades without lying", () => {
    expect(allocationSubNumber("PO-2606-001", 1)).toBe("PO-2606-001-01");
    expect(allocationSubNumber("2990-PO-2606-023", 12)).toBe("2990-PO-2606-023-12");
    expect(allocationSubNumber(null, 3)).toBe("-03");
  });
});
