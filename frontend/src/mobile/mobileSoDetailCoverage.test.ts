/* The phone's Sales Order detail must fetch the deferred line coverage.
 *
 * Since 2026-09-01 (docs/bugs/0592) `GET /mfg-sales-orders/:docNo` returns
 * `coverage_po: null`, `stock_state: null` and `ready_source_pos: []` for every
 * stocked line, and the live values come from a SECOND call,
 * `GET /mfg-sales-orders/:docNo/coverage`. Desktop (`SalesOrderDetailV2`) makes
 * that call and overlays it; the list drill-down was fixed for the same miss in
 * docs/bugs/0598. The phone never did — no file under `frontend/src/mobile`
 * called the coverage hook — so the phone's line card could never show the
 * incoming purchase order or the READY source (`SourcePosRowMobile` renders the
 * incoming chip only when `stock_state === "po" && coverage_po`). Found while
 * tracing staff issues #18 / #19, 2026-09-14.
 *
 * A SOURCE pin, deliberately: the screen needs auth, router and six queries to
 * render, and the overlay it must call is already unit-tested
 * (vendor/scm/lib/so-coverage-overlay.test.ts). What is pinned here is that the
 * phone USES the same two pieces the desktop does. FAILS on the pre-fix file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(__dirname, "MobileSODetail.tsx"), "utf8");

describe("MobileSODetail reads the deferred SO line coverage", () => {
  it("fetches GET /:docNo/coverage through the shared hook", () => {
    expect(src).toMatch(/useSoLineCoverage\(docNo\)/);
  });

  it("overlays it onto the lines it renders, with the shared overlay", () => {
    expect(src).toMatch(/import \{ overlaySoLineCoverage \} from "\.\.\/vendor\/scm\/lib\/so-coverage-overlay"/);
    expect(src).toMatch(/const items = useMemo\(\s*\(\) => overlaySoLineCoverage\(/);
  });
});
