import { describe, expect, test } from "vitest";
import {
  freezeShipCost,
  aggregateDoLines,
  aggregateSiLines,
  computeLineComparison,
  filterRows,
  summarize,
  groupRows,
  dimensionKeyLabel,
  normaliseCategoryKey,
  categoryLabel,
  escapeLikeLiteral,
  type LineComparison,
  type LineDims,
} from "../src/scm/lib/fulfillment-costing";
import { canViewScmFinance } from "../src/scm/lib/houzs-perms";
import {
  parseAmountCenti,
  buildLines,
  buildAllocations,
} from "../src/scm/routes/payment-vouchers";
import type { AuthUser } from "../src/services/auth";

/* The Fulfillment Costing report's correctness is money: a THREE-WAY split
   (① order / ② DO ship-time FIFO / ③ SI landed) that must stay distinct after a
   supplier PI recost collapses ②→③ in the live column. These pin the exact
   behaviours the migration + write-path change exist to guarantee:
     (a) ship freezes ship_cost_centi ONCE;
     (b) a later recost changes the live unit cost but leaves the frozen ②;
     (c) the report shows three DISTINCT numbers for a shipped+PI'd line and
         falls back + flags legacy rows;
     (d) filters + group-by work for all four dimensions;
     (e) the permission gate blocks a sales user. */

// ── (a) + (b) the freeze decision (the money-path half) ─────────────────────
describe("freezeShipCost — freeze once, never overwrite", () => {
  test("(a) first post-ship costing freezes: NULL → the ship-time unit cost", () => {
    expect(freezeShipCost(null, 1000)).toBe(1000);
    expect(freezeShipCost(undefined, 1000)).toBe(1000);
  });

  test("(b) a later recost does NOT rewrite it: already set → undefined (no write)", () => {
    // undefined is the signal the route uses to omit ship_cost_centi from the
    // UPDATE — so recost changes unit_cost_centi but leaves the frozen ②.
    expect(freezeShipCost(1000, 1200)).toBeUndefined();
  });

  test("zero is a REAL frozen value, not 'unset' — a genuinely free line stays 0", () => {
    // == null is deliberate (catches null + undefined only); 0 must not re-freeze.
    expect(freezeShipCost(0, 1200)).toBeUndefined();
  });

  test("the ship→PI lifecycle end to end", () => {
    // At ship: nothing frozen yet, FIFO unit = 1000.
    const atShip = freezeShipCost(null, 1000);
    expect(atShip).toBe(1000);
    // PI lands, recost re-runs restampDoActualCost with the landed unit = 1200.
    const atRecost = freezeShipCost(atShip ?? null, 1200);
    expect(atRecost).toBeUndefined(); // ship_cost_centi stays 1000; unit becomes 1200.
  });
});

// ── DO / SI aggregation ──────────────────────────────────────────────────────
describe("aggregateDoLines — ② resolution", () => {
  test("frozen ship cost is used and is distinct from the live (landed) cost", () => {
    const agg = aggregateDoLines([
      { qty: 2, unit_cost_centi: 1200, line_cost_centi: 2400, ship_cost_centi: 1000 },
    ]);
    expect(agg.present).toBe(true);
    expect(agg.isLegacy).toBe(false);
    expect(agg.shipUnitCenti).toBe(1000); // ② frozen
    expect(agg.shipLineCenti).toBe(2000);
    expect(agg.liveUnitCenti).toBe(1200); // == ③ after PI
  });

  test("weighted across multiple delivering DO lines", () => {
    const agg = aggregateDoLines([
      { qty: 2, unit_cost_centi: 1200, line_cost_centi: 2400, ship_cost_centi: 1000 },
      { qty: 1, unit_cost_centi: 1200, line_cost_centi: 1200, ship_cost_centi: 1300 },
    ]);
    expect(agg.qty).toBe(3);
    expect(agg.shipLineCenti).toBe(2 * 1000 + 1 * 1300); // 3300
    expect(agg.shipUnitCenti).toBe(Math.round(3300 / 3)); // 1100
  });

  test("legacy: a NULL ship_cost taints the line — ② falls back to live + is flagged", () => {
    const agg = aggregateDoLines([
      { qty: 1, unit_cost_centi: 1200, line_cost_centi: 1200, ship_cost_centi: null },
    ]);
    expect(agg.isLegacy).toBe(true);
    expect(agg.shipUnitCenti).toBe(1200); // == live, honest fallback
    expect(agg.liveUnitCenti).toBe(1200);
  });

  test("no DO lines → not present, no legacy", () => {
    const agg = aggregateDoLines([]);
    expect(agg.present).toBe(false);
    expect(agg.isLegacy).toBe(false);
    expect(agg.shipUnitCenti).toBeNull();
  });
});

describe("aggregateSiLines — ③ resolution", () => {
  test("weighted landed unit cost", () => {
    const agg = aggregateSiLines([
      { qty: 2, unit_cost_centi: 1200, line_cost_centi: 2400 },
      { qty: 1, unit_cost_centi: 1500, line_cost_centi: 1500 },
    ]);
    expect(agg.present).toBe(true);
    expect(agg.lineCenti).toBe(3900);
    expect(agg.unitCenti).toBe(Math.round(3900 / 3)); // 1300
  });

  test("no SI lines → not present (this is what makes a line 'pending')", () => {
    expect(aggregateSiLines([]).present).toBe(false);
  });
});

const dims = (over: Partial<LineDims> = {}): LineDims => ({
  so_item_id: "so-1",
  doc_no: "SO-1",
  item_code: "ITM-1",
  item_name: "Item One",
  category: "MATTRESS",
  customer_state: "Selangor",
  menu: "Model A",
  qty: 1,
  ...over,
});

// ── (c) three distinct numbers + legacy fallback ────────────────────────────
describe("computeLineComparison — (c) the three-way split", () => {
  test("shipped + PI'd line shows three DISTINCT numbers with correct variances", () => {
    const row = computeLineComparison({
      dims: dims({ qty: 2 }),
      order: { unitCenti: 800, lineCenti: 1600 },
      doAgg: aggregateDoLines([{ qty: 2, unit_cost_centi: 1200, line_cost_centi: 2400, ship_cost_centi: 1000 }]),
      siAgg: aggregateSiLines([{ qty: 2, unit_cost_centi: 1200, line_cost_centi: 2400 }]),
    });
    // ① 800  ② 1000  ③ 1200 — all different.
    expect(row.order_unit_centi).toBe(800);
    expect(row.do_unit_centi).toBe(1000);
    expect(row.si_unit_centi).toBe(1200);
    expect(new Set([row.order_unit_centi, row.do_unit_centi, row.si_unit_centi]).size).toBe(3);
    expect(row.do_cost_is_legacy).toBe(false);
    expect(row.pending).toBe(false);
    // variances (unit): ②−① = +200 (+25%), ③−② = +200 (+20%), ③−① = +400 (+50%).
    expect(row.var_do_order_centi).toBe(200);
    expect(row.var_do_order_pct).toBeCloseTo(25);
    expect(row.var_si_do_centi).toBe(200);
    expect(row.var_si_do_pct).toBeCloseTo(20);
    expect(row.var_si_order_centi).toBe(400);
    expect(row.max_abs_var_pct).toBeCloseTo(25);
  });

  test("legacy DO row: ②≈③ but FLAGGED so the owner reads it as a limitation, not convergence", () => {
    const row = computeLineComparison({
      dims: dims(),
      order: { unitCenti: 800, lineCenti: 800 },
      doAgg: aggregateDoLines([{ qty: 1, unit_cost_centi: 1200, line_cost_centi: 1200, ship_cost_centi: null }]),
      siAgg: aggregateSiLines([{ qty: 1, unit_cost_centi: 1200, line_cost_centi: 1200 }]),
    });
    expect(row.do_cost_is_legacy).toBe(true);
    expect(row.do_unit_centi).toBe(row.si_unit_centi); // ②≈③, the legacy limit
  });

  test("pending: delivered but not yet invoiced → no ③, flagged pending", () => {
    const row = computeLineComparison({
      dims: dims(),
      order: { unitCenti: 800, lineCenti: 800 },
      doAgg: aggregateDoLines([{ qty: 1, unit_cost_centi: 1000, line_cost_centi: 1000, ship_cost_centi: 1000 }]),
      siAgg: aggregateSiLines([]),
    });
    expect(row.pending).toBe(true);
    expect(row.si_present).toBe(false);
    expect(row.si_unit_centi).toBeNull();
    expect(row.var_si_do_pct).toBeNull(); // no lie off an absent stage
  });
});

// ── (d) filters + group-by for all four dimensions ──────────────────────────
function sampleRows(): LineComparison[] {
  const mk = (over: Partial<LineDims>, order: number, doShip: number, si: number | null) =>
    computeLineComparison({
      dims: dims(over),
      order: { unitCenti: order, lineCenti: order * (over.qty ?? 1) },
      doAgg: aggregateDoLines([{ qty: over.qty ?? 1, unit_cost_centi: doShip, line_cost_centi: doShip * (over.qty ?? 1), ship_cost_centi: doShip }]),
      siAgg: si == null ? aggregateSiLines([]) : aggregateSiLines([{ qty: over.qty ?? 1, unit_cost_centi: si, line_cost_centi: si * (over.qty ?? 1) }]),
    });
  return [
    mk({ so_item_id: "a", item_code: "ITM-1", category: "MATTRESS", menu: "Model A", customer_state: "Selangor" }, 1000, 1000, 1010), // ~1% var
    mk({ so_item_id: "b", item_code: "ITM-2", category: "SOFA", menu: "Model B", customer_state: "Johor" }, 1000, 1200, 1200),     // 20% var
    mk({ so_item_id: "c", item_code: "ITM-1", category: "MATTRESS", menu: "Model A", customer_state: "Johor" }, 1000, 1000, null),  // pending
  ];
}

describe("filterRows — (d) variance + pending", () => {
  test("minVariancePct keeps only rows above the threshold", () => {
    const kept = filterRows(sampleRows(), { minVariancePct: 5 });
    expect(kept.map((r) => r.so_item_id)).toEqual(["b"]); // only the 20% row
  });

  test("pendingOnly keeps only rows with no landed cost", () => {
    const kept = filterRows(sampleRows(), { pendingOnly: true });
    expect(kept.map((r) => r.so_item_id)).toEqual(["c"]);
  });

  test("no filter → all rows", () => {
    expect(filterRows(sampleRows(), {})).toHaveLength(3);
  });
});

describe("groupRows — (d) all four dimensions", () => {
  test("by item", () => {
    const g = groupRows(sampleRows(), "item");
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.lines]));
    expect(byKey["ITM-1"]).toBe(2);
    expect(byKey["ITM-2"]).toBe(1);
  });

  test("by category — key is the CASE-FOLDED value, label is canonical", () => {
    const g = groupRows(sampleRows(), "category");
    expect(new Set(g.map((x) => x.key))).toEqual(new Set(["mattress", "sofa"]));
    expect(new Set(g.map((x) => x.label))).toEqual(new Set(["Mattress", "Sofa"]));
  });

  test("by menu", () => {
    const g = groupRows(sampleRows(), "menu");
    expect(new Set(g.map((x) => x.key))).toEqual(new Set(["Model A", "Model B"]));
  });

  test("by state", () => {
    const g = groupRows(sampleRows(), "state");
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.lines]));
    expect(byKey["Johor"]).toBe(2);
    expect(byKey["Selangor"]).toBe(1);
  });

  /* The owner-reported prod defect: `bedframe` and `BEDFRAME` rendered as two
     groups, each with its own partial line count and variance, and nothing on
     screen said so. `item_group` is unconstrained text written by two writers
     that disagree about case, so the fold happens at read time. */
  test("case-variant categories collapse into ONE group with the FULL total", () => {
    const mk = (id: string, category: string, order: number) =>
      computeLineComparison({
        dims: dims({ so_item_id: id, category }),
        order: { unitCenti: order, lineCenti: order },
        doAgg: aggregateDoLines([]),
        siAgg: aggregateSiLines([{ qty: 1, unit_cost_centi: order + 100, line_cost_centi: order + 100 }]),
      });
    const g = groupRows(
      [mk("a", "bedframe", 1000), mk("b", "BEDFRAME", 2000), mk("c", "Bedframe", 3000)],
      "category",
    );
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe("bedframe");
    expect(g[0].label).toBe("Bedframe");
    // The whole point: the count and the money are the SUM of all three
    // spellings, not whichever spelling happened to be stored first.
    expect(g[0].lines).toBe(3);
    expect(g[0].order_cost_centi).toBe(6000);
    expect(g[0].variance_centi).toBe(300);
  });

  test("surrounding whitespace does not fork a category either", () => {
    expect(normaliseCategoryKey("  SOFA  ")).toBe("sofa");
    expect(normaliseCategoryKey("Bed  frame")).toBe("bed frame");
  });

  test("`others` is labelled as the fallback it is, not as a product family", () => {
    // It has NO counterpart in the mfg_product_category enum — it is synthesised
    // when the product lookup misses, and is also the SO line editor's default.
    expect(categoryLabel("others")).toBe("Others (uncategorised)");
    expect(categoryLabel("OTHERS")).toBe("Others (uncategorised)");
  });

  test("an unrecognised category is shown verbatim, never hidden or blanked", () => {
    expect(categoryLabel("Curtains")).toBe("Curtains");
    expect(categoryLabel(null)).toBe("Unspecified");
    expect(categoryLabel("   ")).toBe("Unspecified");
  });

  test("escapeLikeLiteral makes the drill-down filter an equality, not a pattern", () => {
    // A merged bucket's drill-down uses ilike; without escaping, a category
    // containing % would match unrelated rows and the detail would contradict
    // the total it was opened from.
    expect(escapeLikeLiteral("50%_off")).toBe("50\\%\\_off");
    expect(escapeLikeLiteral("bedframe")).toBe("bedframe");
  });

  test("a missing dimension value groups under Unspecified, not dropped", () => {
    const rows = [computeLineComparison({
      dims: dims({ customer_state: null }),
      order: { unitCenti: 100, lineCenti: 100 },
      doAgg: aggregateDoLines([]),
      siAgg: aggregateSiLines([]),
    })];
    const g = groupRows(rows, "state");
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe("");
    expect(g[0].label).toBe("Unspecified");
    expect(dimensionKeyLabel(rows[0], "state").label).toBe("Unspecified");
  });
});

describe("summarize — the 5-tile strip", () => {
  test("totals, variance, pending + legacy counts", () => {
    const s = summarize(sampleRows());
    expect(s.lines).toBe(3);
    expect(s.order_cost_centi).toBe(3000);          // 1000*3
    expect(s.do_cost_centi).toBe(1000 + 1200 + 1000); // 3200
    expect(s.si_cost_centi).toBe(1010 + 1200 + 0);    // 2210 (pending row contributes 0)
    expect(s.pending_count).toBe(1);
    expect(s.legacy_count).toBe(0);
    expect(s.variance_centi).toBe(s.si_cost_centi - s.order_cost_centi);
  });
});

// ── (e) permission gate blocks a sales user ─────────────────────────────────
function user(over: { position_name?: string | null; perms?: string[] }): AuthUser {
  const perms = over.perms ?? [];
  return {
    id: 1, email: "t@test.local", name: "t", role_id: 1, role_name: "r",
    position_id: 1, position_name: over.position_name ?? null, status: "active",
    permissions: perms, permissions_set: new Set(perms), manager_id: null,
    scope_to_pic: false, department_id: null, department_name: null,
    brand_scope: null, page_access: {}, scm_l2_configured: false,
  } as AuthUser;
}
function ctx(u: AuthUser | null) {
  return {
    get: (_k: "houzsUser") =>
      u === null ? undefined : { position_name: u.position_name, permissions_set: u.permissions_set },
  } as Parameters<typeof canViewScmFinance>[0];
}

describe("(e) the report's finance gate blocks sales, admits finance", () => {
  test("a Sales Executive is refused — the endpoint 403s on this being false", () => {
    expect(canViewScmFinance(ctx(user({ position_name: "Sales Executive" })))).toBe(false);
  });

  test("directors / finance are admitted", () => {
    for (const pos of ["Sales Director", "Finance Manager", "Super Admin"]) {
      expect(canViewScmFinance(ctx(user({ position_name: pos })))).toBe(true);
    }
    expect(canViewScmFinance(ctx(user({ position_name: "Owner", perms: ["*"] })))).toBe(true);
  });

  test("no caller → refused (fails closed)", () => {
    expect(canViewScmFinance(ctx(null))).toBe(false);
  });
});

/* ── Payment-voucher money in, from the wire ───────────────────────────────
   Ported from HOOKKA's BUG-2026-05-20-002 (a negative payment amount was
   accepted and silently subtracted). Houzs's variant was quieter and therefore
   harder to notice: buildLines ran the wire value through
   `Math.max(0, Math.round(Number(x)) || 0)`, so a negative or unparseable
   amount became a silent 0. The voucher saved, returned 200, and its header
   total was short by exactly the line nobody was told about.

   These pin the boundary: a payable amount is a non-negative INTEGER sen. */
describe("payment voucher — line amounts are validated, not clamped", () => {
  test("parseAmountCenti admits a plain non-negative integer sen", () => {
    expect(parseAmountCenti(0)).toBe(0);
    expect(parseAmountCenti(150000)).toBe(150000);
  });

  test("parseAmountCenti refuses what the old clamp turned into a silent zero", () => {
    expect(parseAmountCenti(-500000)).toBeNull();   // was 0
    expect(parseAmountCenti("abc")).toBeNull();     // was 0
    expect(parseAmountCenti(NaN)).toBeNull();       // was 0
    expect(parseAmountCenti(Infinity)).toBeNull();  // was 0
  });

  test("parseAmountCenti refuses a fractional amount — that is RM in a sen field", () => {
    expect(parseAmountCenti(48.5)).toBeNull();
  });

  test("a negative line is refused outright rather than saved as a zero line", () => {
    expect(buildLines([{ debitAccountCode: "500-0000", amountCenti: -500000 }]))
      .toEqual({ error: "line_amount_invalid" });
  });

  test("a valid line still builds, and the header total is its sum", () => {
    const built = buildLines([
      { debitAccountCode: "500-0000", amountCenti: 150000 },
      { debitAccountCode: "500-0001", amountCenti: 25000 },
    ]);
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.total).toBe(175000);
    expect(built.rows.map((r) => r.line_no)).toEqual([1, 2]);
  });

  test("an existing guard is untouched — a line with no debit account still fails on that", () => {
    expect(buildLines([{ amountCenti: 1000 }])).toEqual({ error: "debit_account_required" });
  });

  test("a negative ALLOCATION is refused, not silently dropped as a zero row", () => {
    expect(buildAllocations([{ piId: "pi-1", amountCenti: -1 }]))
      .toEqual({ error: "allocation_amount_invalid" });
  });

  test("allocations still sum, and an explicit zero row is still dropped", () => {
    const a = buildAllocations([
      { piId: "pi-1", amountCenti: 40000 },
      { piId: "pi-2", amountCenti: 0 },
    ]);
    expect("error" in a).toBe(false);
    if ("error" in a) return;
    expect(a.total).toBe(40000);
    expect(a.rows).toEqual([{ pi_id: "pi-1", amount_centi: 40000 }]);
  });
});
