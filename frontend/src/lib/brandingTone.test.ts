import { describe, expect, test } from "vitest";
import { brandingToneForCategory, brandingToneForLabel } from "./brandingTone";

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

  test.each([null, undefined, "", "   "])("an unreadable category (%p) is neutral", (c) => {
    expect(brandingToneForCategory(c)).toBe("neutral");
  });

  test("the four groups really are four different colours", () => {
    const four = ["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY"].map(brandingToneForCategory);
    expect(new Set(four).size).toBe(4);
  });
});

describe("brandingToneForLabel — the bridge for lists with no category", () => {
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
