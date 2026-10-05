// The production rows this repair exists for (read 2026-10-05), and the ones it
// must leave alone.
import { describe, expect, it } from "vitest";

import { brandlessSofaName } from "../scripts/lib/sofa-brandless-name.mjs";

describe("brandlessSofaName", () => {
  it("strips a 2990 brand that itself ends in SOFA", () => {
    expect(brandlessSofaName({ name: "2990S SOFA SOFA BANGGAU 1A(LHF)", branding: "2990s Sofa", modelName: "BANGGAU", code: "8075-1A(LHF)" }))
      .toEqual({ ok: true, to: "SOFA BANGGAU 1A(LHF)" });
    expect(brandlessSofaName({ name: "2990S SOFA SOFA TELLUC 1A(RHF)", branding: "2990s Sofa", modelName: "Telluc", code: "TELLUC-1A(RHF)" }))
      .toEqual({ ok: true, to: "SOFA TELLUC 1A(RHF)" });
  });

  it("strips a Houzs brand", () => {
    expect(brandlessSofaName({ name: "ZANOTTI SOFA SOFFIO 2B(LHF)", branding: "ZANOTTI", modelName: "Soffio", code: "8030-2B(LHF)" }))
      .toEqual({ ok: true, to: "SOFA SOFFIO 2B(LHF)" });
  });

  it("leaves a correct name alone", () => {
    expect(brandlessSofaName({ name: "SOFA BANGGAU 1A(LHF)", branding: "2990s Sofa", modelName: "BANGGAU", code: "8075-1A(LHF)" })).toBeNull();
    expect(brandlessSofaName({ name: "SOFA ADDA 2S", branding: "", modelName: "ADDA", code: "ADDA-2S" })).toBeNull();
    // A brand literally named SOFA must not eat the house word.
    expect(brandlessSofaName({ name: "SOFA ADDA 2S", branding: "Sofa", modelName: "ADDA", code: "ADDA-2S" })).toBeNull();
  });

  it("refuses a name that does not strip to the house name", () => {
    const r = brandlessSofaName({ name: "ZANOTTI SOFA SOFFIO 2B(LHF)", branding: "ZANOTTI", modelName: "Soffio", code: "8030-2A(LHF)" });
    expect(r?.ok).toBe(false);
    expect(brandlessSofaName({ name: "ZANOTTI SOFA SOFFIO 2B(LHF)", branding: "ZANOTTI", modelName: null, code: "8030-2B(LHF)" })?.ok).toBe(false);
  });
});
