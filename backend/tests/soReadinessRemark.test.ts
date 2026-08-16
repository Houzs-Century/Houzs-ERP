import { describe, expect, test } from "vitest";
import { summariseReadiness, type ReadinessLine } from "../src/scm/lib/so-readiness";

/* THE STOCK REMARK NAMES WHAT IS READY.
 *
 * It is the warehouse's "Remark 2" vocabulary, reproduced from AutoCount
 * (docs/stock-reconciliation.md §2), and staff read it to know what they can
 * PULL now. The owner confirmed it against real orders on 2026-08-16:
 *
 *   | state                                            | label           |
 *   | every live line ready (main + acc + service)     | READY           |
 *   | every MAIN line ready, an accessory pending      | PARTIAL         |
 *   | mattress ready, another MAIN category not        | MATTRESS        |
 *   | bedframe ready, another MAIN category not        | BEDFRAME        |
 *   | sofa ready, another MAIN category not            | SOFA            |
 *   | several groups ready                             | BEDFRAME/ACC    |
 *   | nothing ready yet                                | (blank)         |
 *   | accessory-only order, accessory still pending    | (blank)         |
 *
 * TWO RULES THE VOCABULARY MUST KEEP, and each is its own describe below.
 *
 *   · "PARTIAL" REQUIRES A MAIN LINE. It asserts "the main products are in";
 *     an SO with no main line has none. The old code branched on bare
 *     `isMainReady`, which is VACUOUSLY true at mainCount === 0, so an
 *     accessory-only SO with one short accessory printed "READY (PARTIAL)"
 *     while isShipReady on the next line was false. The owner, on a real
 *     order: 「只有配件,有一行没齐 → READY (PARTIAL) ← 骗人 / 明说还缺什么」.
 *     That is why the label is "PARTIAL" and not "READY (PARTIAL)", and why
 *     the branch is guarded by `mainCount > 0`.
 *
 *   · A SERVICE-ONLY SO IS READY ON SIGHT. `if (isServiceLine(...)) continue`
 *     dropped every service line, so such an SO was indistinguishable from one
 *     with no lines at all and could never be ready. Owner: 「如果那张单只有
 *     accessories 的话，accessories ready 应该直接呈现 ready。如果它是 service
 *     的单，也应该直接 ready」.
 *
 * One rule survives both, from PR #2186: an SO with NO lines is never ship-able
 * and carries no label. That is what separates "nothing left to wait for" from
 * "nothing on the order", and service lines are COUNTED now precisely so the
 * two stay separable.
 *
 * The invariant that ties the whole vocabulary together — the label never
 * contains "READY" while anything is short — is asserted last, over every shape
 * at once. It holds on the ready-side vocabulary only because the label is the
 * bare word "PARTIAL".
 */

const main = (stock_status: string, item_group = "MATTRESS"): ReadinessLine => ({ item_group, stock_status });
const acc = (stock_status: string): ReadinessLine => ({ item_group: "ACCESSORIES", stock_status });
const svc = (item_code = "SVC-DELIVERY"): ReadinessLine => ({ item_group: "SERVICE", item_code, stock_status: "PENDING" });

describe("an SO with no lines stays un-shippable and un-labelled (PR #2186)", () => {
  test("no lines at all", () => {
    const r = summariseReadiness([]);
    expect(r.stockRemark).toBe("");
    expect(r.isShipReady).toBe(false);
    expect(r.isFullyReady).toBe(false);
  });

  test("every line cancelled is the same husk", () => {
    const r = summariseReadiness([{ ...main("READY"), cancelled: true }, { ...svc(), cancelled: true }]);
    expect(r.svcCount).toBe(0);
    expect(r.stockRemark).toBe("");
    expect(r.isShipReady).toBe(false);
  });
});

describe("service-only ⇒ READY (owner: 如果它是 service 的单，也应该直接 ready)", () => {
  test("a delivery-fee-only SO is ready on sight", () => {
    const r = summariseReadiness([svc()]);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
    expect(r.isFullyReady).toBe(true);
  });

  test("several service lines, none of them allocated, still READY", () => {
    /* Service lines carry stock_status PENDING forever — nothing allocates to a
       service. If PENDING counted, this SO could never ship. */
    const r = summariseReadiness([svc("SVC-DELIVERY"), svc("SVC-LIFT-CARRY-F3"), svc("SVC-DISPOSE-MATTRESS")]);
    expect(r.svcCount).toBe(3);
    expect(r.readyCategories).toEqual([]);
    expect(r.pendingCategories).toEqual([]);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
  });

  test("the catalog category alone identifies a service line", () => {
    /* isServiceLine calls category its strongest signal, but ReadinessLine had
       no field for it until 2026-08-16, so no caller could pass it. Here both
       weaker signals are wrong — item_group says 'others', the code is not
       SVC-* — and only the catalog knows. Without it this SO is an accessory
       that will never be allocated. */
    const r = summariseReadiness([
      { item_group: "others", item_code: "DELIV-KL", category: "SERVICE", stock_status: "PENDING" },
    ]);
    expect(r.accCount).toBe(0);
    expect(r.svcCount).toBe(1);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
  });
});

describe("accessory-only ⇒ READY when the accessories are in (owner: accessories ready 应该直接呈现 ready)", () => {
  test("all accessories READY", () => {
    const r = summariseReadiness([acc("READY"), acc("READY")]);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
  });

  test("accessories READY plus a service line is still READY", () => {
    const r = summariseReadiness([acc("READY"), svc()]);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
  });
});

describe("accessory-only with one short ⇒ BLANK, never PARTIAL (the 骗人 case)", () => {
  /* The row of the spec the owner cares most about. PARTIAL means "the main
     products are ready"; this order has no main line, so nothing is ready and
     the cell must say nothing. */
  test("one of two accessories short", () => {
    const r = summariseReadiness([acc("READY"), acc("PENDING")]);
    /* The exact regression: isMainReady is vacuously true here — the label used
       to read it BARE and print "READY (PARTIAL)" beside a false ship gate. */
    expect(r.isMainReady).toBe(true);
    expect(r.mainCount).toBe(0);
    expect(r.isShipReady).toBe(false);
    expect(r.stockRemark).toBe("");
    expect(r.readyCategories).toEqual([]);
  });

  test("a PARTIALLY allocated accessory is short, not ready", () => {
    const r = summariseReadiness([acc("PARTIAL")]);
    expect(r.stockRemark).toBe("");
    expect(r.isShipReady).toBe(false);
  });

  test("a short accessory beside a service line is still blank", () => {
    /* svcCount makes liveCount non-zero, so this is NOT the husk case — and it
       still must not claim a readiness the order does not have. */
    const r = summariseReadiness([acc("PENDING"), svc()]);
    expect(r.svcCount).toBe(1);
    expect(r.mainCount).toBe(0);
    expect(r.stockRemark).toBe("");
    expect(r.isShipReady).toBe(false);
  });
});

describe("main lines: the label names what IS ready", () => {
  test("every MAIN line in, an accessory short ⇒ PARTIAL, and it can still ship", () => {
    const r = summariseReadiness([main("READY"), acc("PENDING")]);
    expect(r.isShipReady).toBe(true);           // accessories never block a ship
    expect(r.stockRemark).toBe("PARTIAL");
    expect(r.stockRemark).not.toContain("READY");
  });

  test("PARTIAL is the label — never the old 'READY (PARTIAL)'", () => {
    const r = summariseReadiness([main("READY"), main("READY", "BEDFRAME"), acc("PENDING")]);
    expect(r.stockRemark).toBe("PARTIAL");
  });

  test("mattress in, bedframe not ⇒ MATTRESS", () => {
    const r = summariseReadiness([main("READY", "MATTRESS"), main("PENDING", "BEDFRAME")]);
    expect(r.stockRemark).toBe("MATTRESS");
    expect(r.isShipReady).toBe(false);
  });

  test("bedframe in, mattress not ⇒ BEDFRAME (all caps, the system's casing)", () => {
    const r = summariseReadiness([main("READY", "BEDFRAME"), main("PENDING", "MATTRESS")]);
    expect(r.stockRemark).toBe("BEDFRAME");
  });

  test("sofa in, bedframe not ⇒ SOFA", () => {
    const r = summariseReadiness([main("READY", "SOFA"), main("PENDING", "BEDFRAME")]);
    expect(r.stockRemark).toBe("SOFA");
  });

  test("nothing ready yet ⇒ blank", () => {
    const r = summariseReadiness([main("PENDING")]);
    expect(r.isShipReady).toBe(false);
    expect(r.stockRemark).toBe("");
  });

  test("main short, accessories in ⇒ ACC", () => {
    const r = summariseReadiness([main("PENDING"), acc("READY")]);
    expect(r.stockRemark).toBe("ACC");
    expect(r.isShipReady).toBe(false);
  });

  test("several groups in ⇒ '/'-joined, fixed order BEDFRAME, SOFA, MATTRESS, ACC", () => {
    /* The multi-category shapes that exist in production data —
       docs/stock-reconciliation.md §2.2 counts BEDFRAME/ACC 31 times,
       MATTRESS/ACC 16, ACC/BEDFRAME 2 (the same meaning, typed by hand in the
       other order; the ERP emits one order and the parity checker compares
       order-insensitively). */
    const r = summariseReadiness([
      main("READY", "BEDFRAME"),
      main("PENDING", "MATTRESS"),
      acc("READY"),
    ]);
    expect(r.readyCategories).toEqual(["BEDFRAME", "ACC"]);
    expect(r.stockRemark).toBe("BEDFRAME/ACC");
  });

  test("mattress + accessories in, sofa not ⇒ MATTRESS/ACC", () => {
    const r = summariseReadiness([
      main("READY", "MATTRESS"),
      main("PENDING", "SOFA"),
      acc("READY"),
    ]);
    expect(r.stockRemark).toBe("MATTRESS/ACC");
  });

  test("a category with one short line and one ready line is NOT ready", () => {
    const r = summariseReadiness([main("READY"), main("PENDING")]);
    expect(r.readyCategories).toEqual([]);
    expect(r.stockRemark).toBe("");
  });

  test("everything in ⇒ plain READY", () => {
    const r = summariseReadiness([main("READY"), acc("READY"), svc()]);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
  });

  test("pendingCategories still reports the complement, ACC last", () => {
    const r = summariseReadiness([
      main("PENDING", "BEDFRAME"),
      main("PENDING", "MATTRESS"),
      main("READY", "SOFA"),
      acc("PENDING"),
    ]);
    expect(r.pendingCategories).toEqual(["BEDFRAME", "MATTRESS", "ACC"]);
    expect(r.readyCategories).toEqual(["SOFA"]);
    expect(r.stockRemark).toBe("SOFA");
  });
});

describe("the invariants, over every shape at once", () => {
  const shapes: Array<[string, ReadinessLine[]]> = [
    ["empty", []],
    ["all cancelled", [{ ...main("READY"), cancelled: true }]],
    ["service only", [svc()]],
    ["acc only, all in", [acc("READY")]],
    ["acc only, one short", [acc("READY"), acc("PENDING")]],
    ["acc only, short, plus a service", [acc("PENDING"), svc()]],
    ["main in, acc short", [main("READY"), acc("PENDING")]],
    ["main short", [main("PENDING")]],
    ["main short, acc in", [main("PENDING"), acc("READY")]],
    ["main short + acc short", [main("PENDING"), acc("PENDING")]],
    ["bedframe in, mattress short", [main("READY", "BEDFRAME"), main("PENDING", "MATTRESS")]],
    ["bedframe + acc in, mattress short", [main("READY", "BEDFRAME"), main("PENDING", "MATTRESS"), acc("READY")]],
    ["main in + acc in + svc", [main("READY"), acc("READY"), svc()]],
    ["unknown group, short", [{ item_group: "widgets", stock_status: "PENDING" }]],
    ["unknown group, in", [{ item_group: "widgets", stock_status: "READY" }]],
  ];

  test.each(shapes)("%s — the remark says READY only when nothing is short", (_name, lines) => {
    const r = summariseReadiness(lines);
    if (r.pendingCategories.length > 0) {
      expect(r.stockRemark).not.toContain("READY");
    } else {
      // Nothing short: either the SO is empty (no label) or it is fully ready.
      expect(["", "READY"]).toContain(r.stockRemark);
      expect(r.stockRemark === "READY").toBe(r.isFullyReady);
    }
  });

  test.each(shapes)("%s — the label is exactly the ready list, bar the two words", (_name, lines) => {
    const r = summariseReadiness(lines);
    if (r.stockRemark !== "READY" && r.stockRemark !== "PARTIAL") {
      expect(r.stockRemark).toBe(r.readyCategories.join("/"));
    }
  });

  test.each(shapes)("%s — PARTIAL is never printed without a MAIN line (the 骗人 rule)", (_name, lines) => {
    const r = summariseReadiness(lines);
    if (r.mainCount === 0) expect(r.stockRemark).not.toBe("PARTIAL");
  });

  test.each(shapes)("%s — a REMARK of READY and a false ship gate can never coexist", (_name, lines) => {
    const r = summariseReadiness(lines);
    if (r.stockRemark === "READY") expect(r.isShipReady).toBe(true);
  });

  test.each(shapes)("%s — ready and pending lists never name the same group", (_name, lines) => {
    const r = summariseReadiness(lines);
    for (const cat of r.readyCategories) expect(r.pendingCategories).not.toContain(cat);
  });
});
