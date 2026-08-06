// ----------------------------------------------------------------------------
// The frontend half of the two-logo-slot contract (owner 2026-08-06).
//
// `logoR2Key` is the ON-SCREEN logo (dark app chrome, so normally the light
// artwork); `printLogoR2Key` is the optional one documents use (white paper, so
// normally the dark artwork). letterheadLogoKey MIRRORS the backend resolver of
// the same name — the jspdf letterheads and the server-rendered HTML prints must
// pick the same file, or a Delivery Order downloaded from the app would carry a
// different logo from the same document printed by the server.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { letterheadLogoKey, normalizeBranding, DEFAULT_BRANDING } from "./branding";

describe("letterheadLogoKey", () => {
  test("print slot wins; blank falls back to the on-screen logo", () => {
    expect(letterheadLogoKey({ logoR2Key: "screen.png", printLogoR2Key: "paper.png" })).toBe("paper.png");
    // Every company that only ever uploaded one logo: documents keep printing
    // it, exactly as before this slot existed.
    expect(letterheadLogoKey({ logoR2Key: "screen.png", printLogoR2Key: "" })).toBe("screen.png");
    expect(letterheadLogoKey({ logoR2Key: "screen.png" })).toBe("screen.png");
    expect(letterheadLogoKey({ logoR2Key: "screen.png", printLogoR2Key: "  " })).toBe("screen.png");
    // No logo at all → text-only letterhead.
    expect(letterheadLogoKey({ logoR2Key: "", printLogoR2Key: "" })).toBe("");
  });
});

describe("normalizeBranding + the print slot", () => {
  test("reads camelCase and snake_case, and defaults to blank on legacy rows", () => {
    expect(normalizeBranding({ printLogoR2Key: "paper.png" }).printLogoR2Key).toBe("paper.png");
    // The pg driver hands back snake_case; missing it would silently print the
    // screen logo forever (the repo's #1 recurring bug).
    expect(normalizeBranding({ print_logo_r2_key: "paper.png" }).printLogoR2Key).toBe("paper.png");
    // A row written before the slot existed must stay blank, never inherit a
    // default key — blank is what makes documents fall back to logoR2Key.
    expect(normalizeBranding({ logoR2Key: "screen.png" }).printLogoR2Key).toBe("");
    expect(DEFAULT_BRANDING.printLogoR2Key).toBe("");
  });
});
