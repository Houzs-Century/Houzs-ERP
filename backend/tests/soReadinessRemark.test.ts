import { describe, expect, test } from "vitest";
import { summariseReadiness, type ReadinessLine } from "../src/scm/lib/so-readiness";

/* THE STOCK REMARK MUST NAME WHAT IS MISSING.
 *
 * The old remark stated what was READY, and that phrasing let the label
 * contradict the ship gate computed in the same function:
 *
 *   · `const isMainReady = mainCount > 0 ? mainReady === mainCount : true;`
 *     is VACUOUSLY true for an SO with no main line. The label branched on it
 *     (`else if (isMainReady) stockRemark = 'READY (PARTIAL)'`), so an
 *     accessory-only SO with one short accessory read "READY (PARTIAL)" while
 *     `isShipReady` on the very next line was false. The owner hit this on a
 *     real order: 「只有配件,有一行没齐 → READY (PARTIAL) ← 骗人 / 明说还缺什么」.
 *
 *   · `if (isServiceLine(...)) continue;` dropped every service line, so a
 *     service-only SO had mainCount + accCount === 0 and was indistinguishable
 *     from an SO with no lines at all — it could never be ready. Owner:
 *     「如果那张单只有 accessories 的话，accessories ready 应该直接呈现 ready。
 *       如果它是 service 的单，也应该直接 ready」.
 *
 * One rule survives both, from PR #2186: an SO with NO lines is never ship-able
 * and carries no label. That is what separates "nothing left to wait for" from
 * "nothing on the order", and service lines are COUNTED now precisely so the
 * two stay separable.
 *
 * Each owner ruling below is its own case. The invariant that ties them
 * together — the label never contains "READY" while anything is short — is
 * asserted last, over every shape at once.
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

describe("accessory-only with one short ⇒ names it, and never says READY (the 骗人 case)", () => {
  test("one of two accessories short", () => {
    const r = summariseReadiness([acc("READY"), acc("PENDING")]);
    /* The exact regression: isMainReady is vacuously true here — the label used
       to read it and print "READY (PARTIAL)" beside a false ship gate. */
    expect(r.isMainReady).toBe(true);
    expect(r.isShipReady).toBe(false);
    expect(r.stockRemark).toBe("SHORT: ACCESSORY");
    expect(r.stockRemark).not.toContain("READY");
  });

  test("a PARTIALLY allocated accessory is short, not ready", () => {
    const r = summariseReadiness([acc("PARTIAL")]);
    expect(r.stockRemark).toBe("SHORT: ACCESSORY");
    expect(r.isShipReady).toBe(false);
  });
});

describe("main lines: the gate is unchanged, only the label moved", () => {
  test("main READY + accessory short — still ship-able, and the label says what is missing", () => {
    const r = summariseReadiness([main("READY"), acc("PENDING")]);
    expect(r.isShipReady).toBe(true);           // accessories never block a ship
    expect(r.stockRemark).toBe("SHORT: ACCESSORY");
    expect(r.stockRemark).not.toContain("READY");
  });

  test("main short — the label names the main category", () => {
    const r = summariseReadiness([main("PENDING")]);
    expect(r.isShipReady).toBe(false);
    expect(r.stockRemark).toBe("SHORT: MATTRESS");
  });

  test("several categories short — main cats sorted, ACCESSORY last", () => {
    const r = summariseReadiness([
      main("PENDING", "BEDFRAME"),
      main("PENDING", "MATTRESS"),
      main("READY", "SOFA"),
      acc("PENDING"),
    ]);
    expect(r.pendingCategories).toEqual(["BEDFRAME", "MATTRESS", "ACCESSORY"]);
    expect(r.stockRemark).toBe("SHORT: BEDFRAME, MATTRESS, ACCESSORY");
  });

  test("a category with one short line and one ready line still counts as short", () => {
    const r = summariseReadiness([main("READY"), main("PENDING")]);
    expect(r.stockRemark).toBe("SHORT: MATTRESS");
  });

  test("everything in ⇒ READY", () => {
    const r = summariseReadiness([main("READY"), acc("READY"), svc()]);
    expect(r.stockRemark).toBe("READY");
    expect(r.isShipReady).toBe(true);
  });
});

describe("the invariant, over every shape at once", () => {
  /* The single property the owner actually asked for. Anything that ever gets
     added to the remark vocabulary has to keep satisfying it. */
  const shapes: Array<[string, ReadinessLine[]]> = [
    ["empty", []],
    ["all cancelled", [{ ...main("READY"), cancelled: true }]],
    ["service only", [svc()]],
    ["acc only, all in", [acc("READY")]],
    ["acc only, one short", [acc("READY"), acc("PENDING")]],
    ["main in, acc short", [main("READY"), acc("PENDING")]],
    ["main short", [main("PENDING")]],
    ["main short + acc short", [main("PENDING"), acc("PENDING")]],
    ["main in + acc in + svc", [main("READY"), acc("READY"), svc()]],
    ["unknown group, short", [{ item_group: "widgets", stock_status: "PENDING" }]],
    ["unknown group, in", [{ item_group: "widgets", stock_status: "READY" }]],
  ];

  test.each(shapes)("%s — the remark says READY only when nothing is short", (_name, lines) => {
    const r = summariseReadiness(lines);
    const short = r.pendingCategories.length > 0;
    if (short) {
      expect(r.stockRemark).not.toContain("READY");
      expect(r.stockRemark).toBe(`SHORT: ${r.pendingCategories.join(", ")}`);
    } else {
      // Nothing short: either the SO is empty (no label) or it is fully ready.
      expect(["", "READY"]).toContain(r.stockRemark);
      expect(r.stockRemark === "READY").toBe(r.isFullyReady);
    }
  });

  test.each(shapes)("%s — a REMARK of READY and a false ship gate can never coexist", (_name, lines) => {
    const r = summariseReadiness(lines);
    if (r.stockRemark === "READY") expect(r.isShipReady).toBe(true);
  });
});
