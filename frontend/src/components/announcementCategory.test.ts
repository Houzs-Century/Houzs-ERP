import { describe, expect, test } from "vitest";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryRequiresAck,
  readCategory,
  requiresAcknowledgement,
} from "./announcementCategory";

/* The four categories, their CTA wording and which of them block. Every
   surface (modal, inbox, dashboard, bell, phone) reads this one table, so a
   change here is a product-wide change — these tests make that deliberate. */

describe("announcementCategory", () => {
  test("labels and CTA wording are the banner's (Notice / Warning / SOP / Learning)", () => {
    expect(CATEGORY_META.GENERAL.label).toBe("Notice");
    expect(CATEGORY_META.GENERAL.ctaLabel).toBe("Got it");
    expect(CATEGORY_META.WARNING.ctaLabel).toBe("Got it");
    expect(CATEGORY_META.SOP.ctaLabel).toBe("Acknowledge");
    expect(CATEGORY_META.LEARNING.ctaLabel).toBe("Watch");
  });

  test("category colours: petrol / err / brass / trend blue", () => {
    expect(CATEGORY_META.GENERAL.railCls).toBe("bg-primary");
    expect(CATEGORY_META.WARNING.railCls).toBe("bg-err");
    expect(CATEGORY_META.SOP.railCls).toBe("bg-accent");
    expect(CATEGORY_META.LEARNING.railCls).toBe("bg-learning");
    expect(CATEGORY_META.WARNING.pillCls).toBe("bg-err-bg text-err");
  });

  test("WARNING and SOP block; GENERAL and LEARNING never do; the per-notice flag wins", () => {
    expect(categoryRequiresAck("WARNING")).toBe(true);
    expect(categoryRequiresAck("SOP")).toBe(true);
    expect(categoryRequiresAck("GENERAL")).toBe(false);
    expect(categoryRequiresAck("LEARNING")).toBe(false);
    expect(requiresAcknowledgement({ category: "GENERAL", requireAck: true })).toBe(true);
    expect(requiresAcknowledgement({ category: "SOP", requireAck: false })).toBe(false);
    expect(requiresAcknowledgement({})).toBe(false);
  });

  test("readCategory falls back to GENERAL; the composer order leads with the blocking pair", () => {
    expect(readCategory("SOP")).toBe("SOP");
    expect(readCategory("nope")).toBe("GENERAL");
    expect(CATEGORY_ORDER.slice(0, 2)).toEqual(["WARNING", "SOP"]);
  });
});
