import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) =>
  readFileSync(resolve(HERE, "..", "..", "..", rel), "utf8");

const soNew = () => src("pages/scm-v2/SalesOrderNew.tsx");
const soDetail = () => src("pages/scm-v2/SalesOrderDetail.tsx");
const mobileNewSo = () => src("mobile/MobileNewSO.tsx");
const lineCard = () => src("vendor/scm/components/SoLineCard.tsx");

describe("the claim is made from ONE shared helper", () => {
  it("no surface re-implements it inline", () => {
    for (const [name, text] of [
      ["SalesOrderNew", soNew()], ["SalesOrderDetail", soDetail()], ["MobileNewSO", mobileNewSo()],
    ] as const) {
      expect(text, name).not.toMatch(/const zeroPriceClaim\s*=/);
      expect(text, name).toMatch(/from ['"][^'"]*zeroPriceClaim['"]/);
    }
  });
});

describe("SO CREATE now states the intent — desktop and mobile", () => {
  it("desktop create sends the claim, gated on the operator having typed it", () => {
    expect(soNew()).toMatch(/\.\.\.zeroPriceClaim\(l\.unitPriceSen, l\.priceAuthored === true\)/);
  });

  it("mobile create + line-add send it, gated the same way", () => {
    expect(mobileNewSo()).toMatch(/\.\.\.zeroPriceClaim\(toSen\(l\.price\), l\.priceAuthored === true\)/);
  });

  it("the line PATCH claims only an authored 0, on both surfaces (BUG-63)", () => {
    expect(mobileNewSo()).not.toMatch(/\.\.\.zeroPriceClaim\(toSen\(l\.price\), true\)/);
    expect(soDetail()).toMatch(/\.\.\.zeroPriceClaim\(d\.unitPriceSen, d\.priceAuthored === true\)/);
    expect(soDetail().match(/\.\.\.zeroPriceClaim\(d\.unitPriceSen, true\)/g) ?? []).toHaveLength(1);
  });

  it("a product re-pick clears the authored flag, on both surfaces (BUG-63)", () => {
    expect(lineCard()).toMatch(/unitPriceSen: p\.sell_price_sen \?\? 0,[\s\S]{0,120}?priceAuthored:\s*false/);
    expect(mobileNewSo()).toMatch(/price: fromSen\(sku\.unitPriceSen\),\s*priceAuthored: false/);
    expect(soDetail()).toMatch(/unitPriceSen: it\.unit_price_sen \?\? 0,[\s\S]{0,120}?priceAuthored: true/);
  });
});

describe("the authored signal comes from the price box, on both surfaces", () => {
  it("the desktop line card records a typed price", () => {
    expect(lineCard()).toMatch(/onChange\(priceBoxAuthored\(t\)\s*\? \{ unitPriceSen: [^}]{0,40}priceAuthored: true \}\s*: priceBeforeEdit\.current\)/);
  });

  it("the mobile line card records a typed price", () => {
    expect(mobileNewSo()).toMatch(/if \(priceBoxAuthored\(t\)\) \{ setBlankText\(null\); onChange\(\{ price: t, priceAuthored: true \}\); \} else \{ setBlankText\(t\); onChange\(priceBeforeEdit\.current\); \}/);
  });

  it("a line seeded from a PERSISTED row is authored by construction", () => {
    expect(soNew()).toMatch(/priceAuthored: true/);
    expect(mobileNewSo()).toMatch(/priceAuthored: true,/);
  });

  it("a fresh line starts UNauthored, so an untouched 0 stays 'not provided'", () => {
    expect(mobileNewSo()).toMatch(/priceAuthored: false/);
  });
});
