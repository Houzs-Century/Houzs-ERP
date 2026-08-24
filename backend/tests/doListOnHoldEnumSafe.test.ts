import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/* The shared HELD_OR_TERM is `on_hold.is.true,status.eq.ON_HOLD` — the marker
   OR the legacy status label. Four of the five holdable documents can take it,
   because their status enums carry the ON_HOLD label permanently (Postgres has
   no DROP VALUE — document-hold.ts explains why the legacy arm exists).

   scm.do_status is the exception: it NEVER carried ON_HOLD. Comparing an enum
   to a label it does not have is not "matches nothing" — it is a Postgres
   22P02, which PostgREST surfaces as a 400, which the DO list's status-count
   read reports, which the route turns into a 500 for the WHOLE page. That was
   the dead Delivery Orders screen of 2026-08-22..24 ("on_hold count failed:
   unknown error"): every DO-list open in both companies failed while the four
   sibling documents worked fine.

   So the delivery-orders route must filter holds by the MARKER only. This test
   pins that at the source level, because the compiler cannot: HELD_OR_TERM is
   just a string, and every table has the on_hold column — nothing in the types
   knows that one enum lacks the label. */

const src = readFileSync(
  join(__dirname, "../src/scm/routes/delivery-orders-mfg.ts"),
  "utf8",
);

// Comments may cite the names while explaining the rule; code may not.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("delivery-orders route — hold filtering is enum-safe", () => {
  test("never uses the shared HELD_OR_TERM (its legacy arm is a 22P02 on do_status)", () => {
    expect(code).not.toMatch(/\bHELD_OR_TERM\b/);
  });

  test("never sends status.eq.ON_HOLD at the do_status enum", () => {
    expect(code).not.toContain("status.eq.ON_HOLD");
  });

  test("still filters the on-hold tab by the mig-0324 marker", () => {
    expect(src).toMatch(/\.eq\(\s*['"]on_hold['"]\s*,\s*true\s*\)/);
  });
});
