// check-variant-key-drift.mjs says WHY a DO's variant_key differs from the GRN's
// key for the same physical product. What can go silently wrong is the
// judgement: calling an inch-mark spelling a different product, missing the
// totalheight a DO card added, or blaming the wrong side of the chain.
import { describe, expect, it } from "vitest";

import { computeVariantKey } from "../src/scm/shared/variant-key.ts";
import {
  parseVariantKey, canonValue, classifyPair, diffLabels, closestKey, driftSide,
  isNegativeAfterCutover, classifyChain, tally, itemFamily, intEnv,
} from "../scripts/lib/variant-key-drift.mjs";

describe("parseVariantKey", () => {
  it("splits the computeVariantKey format and treats '' as no spec", () => {
    expect(parseVariantKey("fabriccode=bf-16|gap=4")).toEqual([["fabriccode", "bf-16"], ["gap", "4"]]);
    expect(parseVariantKey("")).toEqual([]);
    expect(parseVariantKey(null)).toEqual([]);
  });
});

describe("canonValue", () => {
  it("folds inch marks, case, spaces and hyphens, and sorts specials", () => {
    expect(canonValue("legheight", '6"')).toBe("6");
    expect(canonValue("legheight", "6''")).toBe("6");
    expect(canonValue("legheight", "6 inch")).toBe("6");
    expect(canonValue("legheight", "6”")).toBe("6");
    expect(canonValue("fabriccode", "BF 16")).toBe(canonValue("fabriccode", "bf-16"));
    expect(canonValue("special", "b,a")).toBe(canonValue("special", "a , b"));
    expect(canonValue("fabriccode", "bf-16")).not.toBe(canonValue("fabriccode", "bf-17"));
  });
});

describe("classifyPair", () => {
  const grn = 'fabriccode=bf-16|gap=4"|divanheight=10"|legheight=2"';

  it("names the totalheight the DO card added (the company-2 case)", () => {
    const r = classifyPair(`${grn}|totalheight=16"`, grn);
    expect(r.cls).toBe("field-one-side");
    expect(diffLabels(r.diffs)).toEqual(["totalheight (DO only)"]);
  });

  it("calls a field only the GRN has GRN only", () => {
    const r = classifyPair("fabriccode=bf-16", "fabriccode=bf-16|legheight=6\"");
    expect(r.cls).toBe("field-one-side");
    expect(diffLabels(r.diffs)).toEqual(["legheight (GRN only)"]);
  });

  it("calls an inch-mark spelling a format difference, not a different product", () => {
    const r = classifyPair("fabriccode=bf-16|legheight=6''", 'fabriccode=bf-16|legheight=6"');
    expect(r.cls).toBe("format");
    expect(diffLabels(r.diffs)).toEqual(["legheight (format)"]);
  });

  it("calls a different fabric a different product even when a field is also missing", () => {
    const r = classifyPair("fabriccode=bf-17|totalheight=16", "fabriccode=bf-16");
    expect(r.cls).toBe("different-value");
    expect(diffLabels(r.diffs)).toEqual(["fabriccode (value)", "totalheight (DO only)"]);
  });

  it("separates an empty GRN key and an empty DO key from field drift", () => {
    expect(classifyPair("fabriccode=pc151-02", "").cls).toBe("grn-no-spec");
    expect(classifyPair("", "fabriccode=pc151-02").cls).toBe("do-no-spec");
    expect(classifyPair("", "").cls).toBe("same-key");
  });

  it("agrees with computeVariantKey: a DO with totalHeight vs a GRN without it", () => {
    const parts = { fabricColor: "BF-16", gap: '4"', divanHeight: '10"', legHeight: '2"' };
    const grnKey = computeVariantKey("bedframe", parts);
    const doKey = computeVariantKey("bedframe", { fabricCode: "BF-16", gap: '4"', divanHeight: '10"', legHeight: '2"', totalHeight: '16"' });
    expect(classifyPair(doKey, grnKey).cls).toBe("field-one-side");
    expect(diffLabels(classifyPair(doKey, grnKey).diffs)).toEqual(["totalheight (DO only)"]);
  });

  it("sees a generic item_group as a missing spec (the card rewrites the group to bedframe)", () => {
    const grnKey = computeVariantKey("others", { fabricColor: "BF-16", gap: "4" });
    const doKey = computeVariantKey("bedframe", { fabricCode: "BF-16", gap: "4" });
    expect(grnKey).toBe("");
    expect(classifyPair(doKey, grnKey).cls).toBe("grn-no-spec");
  });
});

describe("closestKey", () => {
  it("prefers a format twin over a field-one-side over a different fabric", () => {
    const doKey = 'fabriccode=bf-16|legheight=6"';
    const r = closestKey(doKey, ["fabriccode=bf-17|legheight=6\"", "fabriccode=bf-16", "fabriccode=bf-16|legheight=6''"]);
    expect(r.key).toBe("fabriccode=bf-16|legheight=6''");
    expect(r.cls).toBe("format");
    expect(closestKey(doKey, [])).toBeNull();
  });
});

describe("driftSide", () => {
  it("blames the side that left the SO line's key", () => {
    expect(driftSide("a", "b", "a")).toBe("DO");
    expect(driftSide("a", "a", "b")).toBe("GRN");
    expect(driftSide("a", "b", "c")).toBe("both");
    expect(driftSide("a", "b", "b")).toBe("none");
    expect(driftSide(null, "b", "a")).toBe("unknown");
  });
});

describe("isNegativeAfterCutover", () => {
  const cut = "2026-08-29";
  it("needs net < 0, no open lot and an OUT on or after the cutover", () => {
    expect(isNegativeAfterCutover({ movementNet: -2, lotOpen: 0, lastOutAt: "2026-09-01T00:00:00Z" }, cut)).toBe(true);
    expect(isNegativeAfterCutover({ movementNet: -2, lotOpen: 0, lastOutAt: "2026-08-01T00:00:00Z" }, cut)).toBe(false);
    expect(isNegativeAfterCutover({ movementNet: -2, lotOpen: 1, lastOutAt: "2026-09-01T00:00:00Z" }, cut)).toBe(false);
    expect(isNegativeAfterCutover({ movementNet: 0, lotOpen: 0, lastOutAt: "2026-09-01T00:00:00Z" }, cut)).toBe(false);
    expect(isNegativeAfterCutover({ movementNet: -1, lotOpen: 0, lastOutAt: null }, cut)).toBe(false);
  });
});

describe("classifyChain", () => {
  const po = [{ id: "p1", poNo: "PO-1", key: "fabriccode=x" }];
  it("reports no PO link when the SO line has none or the DO line has no SO line", () => {
    expect(classifyChain("fabriccode=x", null, po, []).cls).toBe("no-po-link");
    expect(classifyChain("fabriccode=x", "s1", [], []).cls).toBe("no-po-link");
  });
  it("reports a PO with no posted GRN line", () => {
    const r = classifyChain("fabriccode=x", "s1", po, [{ poItemId: "other", key: "fabriccode=x" }]);
    expect(r.cls).toBe("po-no-grn");
    expect(r.ref.poNo).toBe("PO-1");
  });
  it("compares with the closest GRN line of that PO line", () => {
    const grns = [
      { poItemId: "p1", grnNo: "GRN-1", key: "fabriccode=y" },
      { poItemId: "p1", grnNo: "GRN-2", key: "fabriccode=x" },
    ];
    const r = classifyChain("fabriccode=x|totalheight=16", "s1", po, grns);
    expect(r.cls).toBe("field-one-side");
    expect(r.ref.grnNo).toBe("GRN-2");
  });
});

describe("helpers", () => {
  it("tally counts every label a row carries, most first", () => {
    expect(tally([{ l: ["a", "b"] }, { l: ["a"] }], (r) => r.l)).toEqual([["a", 2], ["b", 1]]);
  });
  it("itemFamily groups by the leading name", () => {
    expect(itemFamily("CODY-(K)")).toBe("CODY");
    expect(itemFamily("CELENE (A) 6FT")).toBe("CELENE");
    expect(itemFamily("SQUARE PILLOW")).toBe("SQUARE PILLOW");
  });
  it("intEnv falls back on junk and caps", () => {
    expect(intEnv("x", 20, 200)).toBe(20);
    expect(intEnv("999", 20, 200)).toBe(200);
  });
});
