// WO-7 — the thumbnail key vocabulary is a CROSS-STACK contract: the
// frontend derives thumb keys/URLs by appending the same suffix
// (frontend/src/lib/imagePipeline.ts THUMB_KEY_SUFFIX). If either side
// drifts, every gallery silently falls back to full-size originals and the
// bandwidth win evaporates without an error anywhere. These tests pin the
// backend half.

import { describe, expect, it } from "vitest";
import {
  baseKeyOf,
  isThumbKey,
  isValidThumbPart,
  THUMB_MAX_BYTES,
  THUMB_SUFFIX,
  thumbKeyFor,
} from "../src/services/photoThumbs";

describe("photoThumbs key vocabulary", () => {
  it("suffix matches the frontend contract", () => {
    expect(THUMB_SUFFIX).toBe(".thumb");
  });

  it("thumbKeyFor and baseKeyOf are inverses", () => {
    const key = "so-items/SO-2607-001/item-1/abc.jpg";
    expect(thumbKeyFor(key)).toBe(`${key}.thumb`);
    expect(baseKeyOf(thumbKeyFor(key))).toBe(key);
  });

  it("baseKeyOf passes non-thumb keys through unchanged", () => {
    expect(baseKeyOf("slips/2026/07/x.webp")).toBe("slips/2026/07/x.webp");
  });

  it("isThumbKey rejects the bare suffix and non-thumb keys", () => {
    expect(isThumbKey("a.jpg.thumb")).toBe(true);
    expect(isThumbKey(".thumb")).toBe(false);
    expect(isThumbKey("a.jpg")).toBe(false);
  });
});

describe("isValidThumbPart", () => {
  it("accepts a small image File and rejects everything else", () => {
    const img = new File([new Uint8Array(10)], "t.webp", { type: "image/webp" });
    expect(isValidThumbPart(img)).toBe(true);
    // A multipart text field arrives as a string.
    expect(isValidThumbPart("not-a-file")).toBe(false);
    expect(isValidThumbPart(undefined)).toBe(false);
    const pdf = new File([new Uint8Array(10)], "t.pdf", { type: "application/pdf" });
    expect(isValidThumbPart(pdf)).toBe(false);
    const huge = new File([new Uint8Array(THUMB_MAX_BYTES + 1)], "t.jpg", { type: "image/jpeg" });
    expect(isValidThumbPart(huge)).toBe(false);
    const empty = new File([], "t.jpg", { type: "image/jpeg" });
    expect(isValidThumbPart(empty)).toBe(false);
  });
});
