import { describe, expect, test } from "vitest";
import {
  groupKeyFor,
  windowStartOf,
  DEFAULT_MATTRESS_WINDOW_DAYS,
  type GroupKeyInput,
  type PoMode,
} from "../src/scm/lib/po-grouping";

/* The owner's per-category PO rule, RE-SPEC 2026-09-11 (supersedes 2026-07-17).
   One global toggle; each category responds differently — see po-grouping.ts:

     PER-SO   every (SO, category) its own PO — sofa split from its accessories.
     COMBINE  sofa + its accessories on ONE PO; bedframe per-SO (toggle no-op);
              mattress merged within the delivery WEEK; accessory merged across
              SOs unless it belongs to a sofa order (then it rides with the sofa).

   The mattress window is the load-bearing part: unbounded merging would fold a
   mattress due in three months into this week's PO — stock landing a quarter
   early, turnover made WORSE by the rule meant to improve it. */

const WH = "11111111-1111-4111-8111-111111111111";
const SUP = "22222222-2222-4222-8222-222222222222";

function line(over: Partial<GroupKeyInput> = {}): GroupKeyInput {
  return {
    warehouseId: WH,
    supplierId: SUP,
    soDocNo: "SO-2607-001",
    itemGroup: "mattress",
    deliveryDate: "2026-12-09", // a Wednesday
    ...over,
  };
}

/** groupKeyFor with the batch sofa-context spelled out per call. */
function key(over: Partial<GroupKeyInput>, toggle: PoMode, sofaSos: string[] = []): string {
  return groupKeyFor(line(over), toggle, { sofaSoDocNos: new Set(sofaSos) });
}

describe("windowStartOf — a 7-day window IS the ISO week, so a human can name it", () => {
  test("every day of one Mon-Sun week buckets to that Monday", () => {
    for (const d of ["2026-12-07", "2026-12-09", "2026-12-13"]) {
      expect(windowStartOf(d, 7)).toBe("2026-12-07"); // Monday
    }
  });

  test("the next day after Sunday starts a new bucket", () => {
    expect(windowStartOf("2026-12-13", 7)).toBe("2026-12-07"); // Sun
    expect(windowStartOf("2026-12-14", 7)).toBe("2026-12-14"); // Mon
  });

  test("a 14-day window still lands on a Monday, two weeks apart", () => {
    const a = windowStartOf("2026-12-07", 14)!;
    const b = windowStartOf("2026-12-20", 14)!;
    expect(a).toBe(b);
    expect(windowStartOf("2026-12-21", 14)).not.toBe(a);
  });

  test("an unparseable or missing date yields null — it does not guess a bucket", () => {
    expect(windowStartOf(null, 7)).toBeNull();
    expect(windowStartOf(undefined, 7)).toBeNull();
    expect(windowStartOf("not-a-date", 7)).toBeNull();
    expect(windowStartOf("", 7)).toBeNull();
  });

  test("an ISO timestamp is truncated to its date", () => {
    expect(windowStartOf("2026-12-09T18:00:00Z", 7)).toBe("2026-12-07");
  });
});

describe("PER-SO — everything stays with its own SO, split by category", () => {
  test("the four categories of ONE SO are four separate POs", () => {
    const so = "SO-A";
    const keys = new Set([
      key({ itemGroup: "sofa", soDocNo: so }, "per-so"),
      key({ itemGroup: "bedframe", soDocNo: so }, "per-so"),
      key({ itemGroup: "mattress", soDocNo: so }, "per-so"),
      key({ itemGroup: "accessory", soDocNo: so }, "per-so"),
    ]);
    expect(keys.size).toBe(4);
  });

  test("a sofa and its cover SPLIT under Per-SO — even though the SO has a sofa", () => {
    const so = "SO-A";
    const sofa = key({ itemGroup: "sofa", soDocNo: so }, "per-so", [so]);
    const cover = key({ itemGroup: "accessory", soDocNo: so }, "per-so", [so]);
    expect(cover).not.toBe(sofa);
  });

  test("two SOs never share a PO under Per-SO", () => {
    expect(key({ itemGroup: "sofa", soDocNo: "SO-A" }, "per-so"))
      .not.toBe(key({ itemGroup: "sofa", soDocNo: "SO-B" }, "per-so"));
  });

  test("two bedframe lines of the SAME SO share one PO (supplier-level key)", () => {
    // Same SO + same supplier + same category -> one key, regardless of SKU.
    expect(key({ itemGroup: "bedframe", soDocNo: "SO-A" }, "per-so"))
      .toBe(key({ itemGroup: "bedframe", soDocNo: "SO-A" }, "per-so"));
  });
});

describe("COMBINE — sofa pulls its accessories; mattress/accessory merge; bedframe per-SO", () => {
  test("SOFA: same SO shares one PO — the whole set stays in one dye lot", () => {
    expect(key({ itemGroup: "sofa", soDocNo: "SO-A", deliveryDate: "2026-12-07" }, "combined"))
      .toBe(key({ itemGroup: "sofa", soDocNo: "SO-A", deliveryDate: "2026-12-09" }, "combined"));
  });

  test("SOFA: two SOs never share a PO, even in the same week", () => {
    expect(key({ itemGroup: "sofa", soDocNo: "SO-A" }, "combined"))
      .not.toBe(key({ itemGroup: "sofa", soDocNo: "SO-B" }, "combined"));
  });

  test("SOFA COVER: an accessory on a sofa order RIDES with the sofa (same PO)", () => {
    const so = "SO-A";
    const sofa = key({ itemGroup: "sofa", soDocNo: so }, "combined", [so]);
    const cover = key({ itemGroup: "accessory", soDocNo: so }, "combined", [so]);
    expect(cover).toBe(sofa);
  });

  test("a non-core (Others) line on a sofa order also rides with the sofa", () => {
    const so = "SO-A";
    const sofa = key({ itemGroup: "sofa", soDocNo: so }, "combined", [so]);
    const other = key({ itemGroup: "diffuser", soDocNo: so }, "combined", [so]);
    expect(other).toBe(sofa);
  });

  test("an accessory NOT on a sofa order merges same-supplier across SOs", () => {
    const a = key({ itemGroup: "accessory", soDocNo: "SO-A" }, "combined", []);
    const b = key({ itemGroup: "accessory", soDocNo: "SO-B" }, "combined", []);
    expect(a).toBe(b);
  });

  test("a DIFFERENT-supplier cover cannot join the sofa's PO — the base differs", () => {
    const so = "SO-A";
    const sofa = key({ itemGroup: "sofa", soDocNo: so }, "combined", [so]);
    const cover = key(
      { itemGroup: "accessory", soDocNo: so, supplierId: "99999999-9999-4999-8999-999999999999" },
      "combined",
      [so],
    );
    expect(cover).not.toBe(sofa);
  });

  test("BEDFRAME: two SOs are two POs, and the toggle makes no difference", () => {
    expect(key({ itemGroup: "bedframe", soDocNo: "SO-A" }, "combined"))
      .not.toBe(key({ itemGroup: "bedframe", soDocNo: "SO-B" }, "combined"));
    expect(key({ itemGroup: "bedframe", soDocNo: "SO-A" }, "combined"))
      .toBe(key({ itemGroup: "bedframe", soDocNo: "SO-A" }, "per-so"));
  });

  test("BEDFRAME does not merge into the sofa's PO, even on the same SO", () => {
    const so = "SO-A";
    expect(key({ itemGroup: "bedframe", soDocNo: so }, "combined", [so]))
      .not.toBe(key({ itemGroup: "sofa", soDocNo: so }, "combined", [so]));
  });

  test("MATTRESS: two SOs due the same week share ONE PO", () => {
    expect(key({ itemGroup: "mattress", soDocNo: "SO-A", deliveryDate: "2026-12-07" }, "combined"))
      .toBe(key({ itemGroup: "mattress", soDocNo: "SO-B", deliveryDate: "2026-12-11" }, "combined"));
  });

  test("MATTRESS: the turnover rule — three months out does NOT join this week's PO", () => {
    expect(key({ itemGroup: "mattress", soDocNo: "SO-A", deliveryDate: "2026-12-09" }, "combined"))
      .not.toBe(key({ itemGroup: "mattress", soDocNo: "SO-B", deliveryDate: "2027-03-10" }, "combined"));
  });

  test("MATTRESS: adjacent weeks are separate POs", () => {
    expect(key({ itemGroup: "mattress", deliveryDate: "2026-12-13" }, "combined")) // Sun
      .not.toBe(key({ itemGroup: "mattress", deliveryDate: "2026-12-14" }, "combined")); // Mon
  });

  test("MATTRESS: an undated line falls back to its own SO rather than merging blind", () => {
    const a = key({ itemGroup: "mattress", soDocNo: "SO-A", deliveryDate: null }, "combined");
    const b = key({ itemGroup: "mattress", soDocNo: "SO-B", deliveryDate: null }, "combined");
    expect(a).not.toBe(b);
    expect(a).toContain("SO-A");
  });

  test("MATTRESS: Per-SO does NOT window — same week, but each SO its own PO", () => {
    expect(key({ itemGroup: "mattress", soDocNo: "SO-A", deliveryDate: "2026-12-07" }, "per-so"))
      .not.toBe(key({ itemGroup: "mattress", soDocNo: "SO-B", deliveryDate: "2026-12-09" }, "per-so"));
  });

  test("a mixed pick gets every rule in ONE convert", () => {
    expect(key({ itemGroup: "bedframe", soDocNo: "SO-A" }, "combined"))
      .not.toBe(key({ itemGroup: "bedframe", soDocNo: "SO-B" }, "combined")); // bedframe split
    expect(key({ itemGroup: "mattress", soDocNo: "SO-A" }, "combined"))
      .toBe(key({ itemGroup: "mattress", soDocNo: "SO-B" }, "combined")); // mattress merged (same week default date)
  });
});

describe("every key carries warehouse + supplier, and is stable across runs", () => {
  test("WAREHOUSE stays in every key — each PO must be single-warehouse for the GRN", () => {
    expect(key({ warehouseId: WH }, "combined"))
      .not.toBe(key({ warehouseId: "33333333-3333-4333-8333-333333333333" }, "combined"));
  });

  test("SUPPLIER stays in every key — one PO is one supplier's order", () => {
    expect(key({}, "combined"))
      .not.toBe(key({ supplierId: "44444444-4444-4444-8444-444444444444" }, "combined"));
  });

  test("a null warehouse buckets under a literal, not undefined", () => {
    expect(key({ warehouseId: null }, "combined")).toContain("null::");
  });

  test("the bucket does not depend on WHEN the convert runs — same line, same key", () => {
    const k1 = key({ itemGroup: "mattress", deliveryDate: "2026-12-09" }, "combined");
    const k2 = key({ itemGroup: "mattress", deliveryDate: "2026-12-09" }, "combined");
    expect(k1).toBe(k2);
    expect(k1).toContain("w:2026-12-07");
  });

  test("the default window is a week", () => {
    expect(DEFAULT_MATTRESS_WINDOW_DAYS).toBe(7);
  });
});
