// The old-case backfill copies an SO's postcode onto a service case matched by
// doc number. Doc numbers are not unique across companies, so the SO lookup
// must stay inside the case's own company.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("backfill-assr-case-address", () => {
  it("looks up the case's SO only within the case's company", () => {
    const src = readFileSync(new URL("../scripts/backfill-assr-case-address.mjs", import.meta.url), "utf8");
    const lookup = src.slice(src.indexOf("FROM scm.mfg_sales_orders o"), src.indexOf("LIMIT 1) so"));
    expect(lookup).toMatch(/o\.company_id\s*=\s*c\.company_id/);
  });
});
