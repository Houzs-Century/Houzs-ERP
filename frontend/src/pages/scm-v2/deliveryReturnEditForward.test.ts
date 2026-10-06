// ----------------------------------------------------------------------------
// Delivery Return "Edit" must open an editor (BUG-62).
//
// The V2 detail page is read-only; its Edit button navigates to `?edit=1`.
// Nothing read that flag, and the editor it should open was deleted in #794 as
// "unrouted, no importer", so Edit rewrote the URL and the page stayed
// read-only. Same bug and same fix as purchaseReturnEditForward.test.ts.
// ----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = resolve(__dirname);
const v2 = readFileSync(resolve(here, "DeliveryReturnDetailV2.tsx"), "utf8");
const editor = readFileSync(resolve(here, "DeliveryReturnDetail.tsx"), "utf8");

describe("DeliveryReturnDetailV2 ?edit=1 forward", () => {
  test("the read-only page lazy-loads the editor on ?edit=1", () => {
    expect(v2).toMatch(/lazy\(\(\) =>\s*import\("\.\/DeliveryReturnDetail"\)/);
    expect(v2).toContain('params.get("edit") === "1"');
    expect(v2).toContain("<DeliveryReturnDetailInlineEditor />");
  });

  test("the editor exists under the name the forward imports and saves lines in sen", () => {
    expect(editor).toContain("export const DeliveryReturnDetail =");
    expect(editor).toContain("unitPriceSen: d.unitPriceSen");
    expect(editor).not.toMatch(/_centi|Centi/);
  });

  test("Edit is hidden on a closed return", () => {
    expect(v2).toContain("{!isTerminal && (");
    expect(v2).toContain(") : !isTerminal ? (");
  });
});
