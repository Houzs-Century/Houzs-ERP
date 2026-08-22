import { describe, expect, test } from "vitest";
import { brandingToneForCategory, brandingToneForLabel } from "./brandingTone";

/* THE OWNER'S BUG, as a test. He reported two mattresses in two colours:
 * `2990S MATTRESS` was green because the old rule matched on the digits "2990",
 * and `HAPPI.S MATTRESS` was amber because it matched nothing and fell through.
 * The colour was decided by whose brand name contained a number. */
describe("the reported bug: two mattresses, two colours", () => {
  test("every mattress brand is the same colour, whoever makes it", () => {
    const tones = ["2990S MATTRESS", "HAPPI.S MATTRESS", "HAPPI.S MATTRES", "2990s Mattress", "Mattress"]
      .map(brandingToneForLabel);
    expect(new Set(tones).size).toBe(1);
    expect(tones[0]).toBe("warning");
  });

  test("and it is not the same colour as a sofa or a bedframe", () => {
    const mattress = brandingToneForLabel("HAPPI.S MATTRESS");
    expect(brandingToneForLabel("2990S SOFA")).not.toBe(mattress);
    expect(brandingToneForLabel("BEDFRAME")).not.toBe(mattress);
  });
});

describe("brandingToneForCategory — the accurate entry point", () => {
  test.each([
    ["SOFA", "success"],
    ["BEDFRAME", "accent"],
    ["MATTRESS", "warning"],
    ["ACCESSORY", "neutral"],
    ["SERVICE", "neutral"],
    ["DINING", "neutral"],
    ["BEDLINES", "neutral"],
    ["DIFFUSER", "neutral"],
    ["CARPET", "neutral"],
    ["OTHERS", "neutral"],
  ])("%s is %s", (category, tone) => {
    expect(brandingToneForCategory(category)).toBe(tone);
  });

  /* A row with no readable category must not crash and must not pick a
     meaningful colour it cannot justify. */
  test.each([null, undefined, "", "   "])("an unreadable category (%p) is neutral", (c) => {
    expect(brandingToneForCategory(c)).toBe("neutral");
  });

  test("the four groups really are four different colours", () => {
    const four = ["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY"].map(brandingToneForCategory);
    expect(new Set(four).size).toBe(4);
  });
});

describe("brandingToneForLabel — the bridge for lists with no category", () => {
  /* "ZANOTTI" names no furniture. Before this module a Zanotti sofa read as
     OTHER and turned grey next to a 2990s sofa that was green — the same
     product, two colours, one tenant apart. */
  test.each(["ZANOTTI", "Zanotti", "2990s Sofa", "2990S SOFA", "SOFA"])(
    "%s is the sofa colour", (label) => {
      expect(brandingToneForLabel(label)).toBe("success");
    },
  );

  test.each(["BEDFRAME", "Bedframe", "BED FRAME"])("%s is the bedframe colour", (label) => {
    expect(brandingToneForLabel(label)).toBe("accent");
  });

  test.each(["ACCESSORIES", "Service", "Dining", "Other", "—", "", null, undefined])(
    "%p is neutral", (label) => {
      expect(brandingToneForLabel(label)).toBe("neutral");
    },
  );

  /* MATTRESS wins over SOFA when a label somehow carries both words: the
     mattress noun is the more specific claim, and the order of the checks is
     what decides it. Pinned so a later edit cannot reorder them silently. */
  test("a label carrying both nouns reads as the more specific one", () => {
    expect(brandingToneForLabel("SOFA BED MATTRESS")).toBe("warning");
  });
});

describe("the two entry points agree where both can answer", () => {
  test.each([
    ["SOFA", "2990S SOFA"],
    ["BEDFRAME", "BEDFRAME"],
    ["MATTRESS", "2990S MATTRESS"],
    ["ACCESSORY", "ACCESSORIES"],
  ])("category %s and its label %s land on the same colour", (category, label) => {
    expect(brandingToneForCategory(category)).toBe(brandingToneForLabel(label));
  });
});
