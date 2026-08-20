/* WHERE the RM 0 claim is made — pinned, because the defect was an ABSENCE.
 *
 * `zeroPriceClaim` was a three-line arrow inside SalesOrderDetail.tsx, used by
 * that file's two line writes and by nothing else. So the SO CREATE path and the
 * ENTIRE mobile surface never told the server that a 0 was deliberate, and a
 * line staff marked free came back at full retail:
 *
 *              new SO line at RM 0        existing line edited to RM 0
 *   desktop    reverted to catalogue      stuck (correct)
 *   mobile     reverted to catalogue      reverted to catalogue
 *
 * No unit test over the helper can see a caller that never calls it, which is
 * why this file reads the call sites. Same idiom as the backend's
 * operatorZeroPriceWiring / zeroPriceCreatePath.
 *
 * The second argument is the part worth guarding. Claiming EVERY zero would be
 * the far worse bug: an unpriced catalogue SKU, and every sofa build (priced
 * server-side from its Model's module SKUs), reaches the wire at 0 and would
 * then be persisted at RM 0 instead of being priced. So each site states a FACT
 * about its own 0, and the two facts are different sentences.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/* RAW source, deliberately NOT comment-stripped. A `/*`-stripping pass is
   unsafe on these files: something earlier in SalesOrderNew.tsx opens what
   looks like a block comment and the non-greedy match then swallows real code
   — including the import this file asserts on, which reported a MISSING import
   that is plainly there. Every assertion below is a code shape no comment in
   these files contains, so raw text is the safer input. */
const src = (rel: string) =>
  readFileSync(resolve(HERE, "..", "..", "..", rel), "utf8");

const soNew = () => src("pages/scm-v2/SalesOrderNew.tsx");
const soDetail = () => src("pages/scm-v2/SalesOrderDetail.tsx");
const mobileNewSo = () => src("mobile/MobileNewSO.tsx");
const lineCard = () => src("vendor/scm/components/SoLineCard.tsx");

describe("the claim is made from ONE shared helper", () => {
  it("no surface re-implements it inline", () => {
    // The original three-line arrow. A second copy is how the two clients
    // disagreed about the same amount in the first place.
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
    // ONE body feeds the create items[] and POST /:docNo/items on mobile.
    expect(mobileNewSo()).toMatch(/\.\.\.zeroPriceClaim\(toSen\(l\.price\), l\.priceAuthored === true\)/);
  });

  it("mobile's line PATCH states it unconditionally, like desktop's", () => {
    // An existing line's 0 IS its persisted price; a qty-only edit re-sends the
    // price, so withholding the claim there would re-price a free line.
    expect(mobileNewSo()).toMatch(/\.\.\.zeroPriceClaim\(toSen\(l\.price\), true\)/);
    expect(soDetail().match(/\.\.\.zeroPriceClaim\(d\.unitPriceSen, true\)/g) ?? []).toHaveLength(2);
  });
});

describe("the authored signal comes from the price box, on both surfaces", () => {
  it("the desktop line card records a typed price", () => {
    expect(lineCard()).toMatch(/onChange\(\{ unitPriceSen: [\s\S]{0,60}?priceAuthored: true \}\)/);
  });

  it("the mobile line card records a typed price", () => {
    expect(mobileNewSo()).toMatch(/onChange\(\{ price: e\.target\.value, priceAuthored: true \}\)/);
  });

  it("a line seeded from a PERSISTED row is authored by construction", () => {
    // Copy-to-new-SO (desktop) and edit-prefill (mobile) both carry a price the
    // server already stored. Without this, the mobile edit-DRAFT road — which
    // re-CREATES the order — would hand a free line back to the catalogue.
    expect(soNew()).toMatch(/priceAuthored: true/);
    expect(mobileNewSo()).toMatch(/priceAuthored: true,/);
  });

  it("a fresh line starts UNauthored, so an untouched 0 stays 'not provided'", () => {
    expect(mobileNewSo()).toMatch(/priceAuthored: false/);
  });
});
