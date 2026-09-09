/* `inches()` could not read a value the ERP itself treats as canonical.
 *
 * The ERP's bedframe form offers "No Leg" as a first-class choice and stores
 * that literal string: `src/scm/shared/variant-summary.ts:227` matches
 * `/^NO\s*LEG$/` when it composes the Desc2, and
 * `normalizeInchValue('No Leg')` returns it unchanged. So "No Leg" is not a
 * typo to be tolerated — it is the ERP's own word for zero legs, and our
 * write-back sends it to AutoCount as `NO LEG`.
 *
 * `parseBedframe` reads the book's `NO LEG` as 0. `inches()` read the ERP's
 * `No Leg` as null. The axis therefore reported "the ERP is blank" on a line
 * where both systems agree there is no leg — which is a difference on a
 * PROCEEDED order. Measured on run 34305393684: `HC-SO-2609-005` holds
 * `{"legHeight": "No Leg", "divanHeight": "10\"", "gap": "10\"",
 * "totalHeight": "20\""}` against a book line reading
 * `PC151-10 / DIVAN 10" + NO LEG / GAP 10" / T.Heights 20"`. Every other value
 * on that line matches exactly.
 *
 * WHY IT HAD NOT BEEN SEEN. The MIGRATION writer never produces the string:
 * `bedframeVariants` writes `bf.leg + '"'`, so a migrated zero leg is stored as
 * `0"` and reads fine. Only a line entered or edited through the ERP's own form
 * carries "No Leg" — which today is the orders the ERP itself raised, and
 * tomorrow is every order the staff touch.
 *
 * WRITTEN RED FIRST. Against the reader as it stood, the three "No Leg" cases
 * below failed with `expected null to be 0`; the numeric cases passed, which is
 * the control that says the fix did not simply make everything zero.
 */
import { describe, expect, it } from "vitest";

import { inches, verdictOf, AGREE, ERP_BLANK } from "../scripts/lib/variant-reconcile.mjs";

describe("inches", () => {
  it("reads the ERP's own word for a missing leg as zero", () => {
    expect(inches("No Leg")).toBe(0);
    expect(inches("NO LEG")).toBe(0);
    expect(inches("no legs")).toBe(0);
    expect(inches(" No  Leg ")).toBe(0);
  });

  /* THE CONTROL. A real measurement must not be flattened to zero, and the
     three spellings the reader already knew must still answer the same. */
  it("still reads every height it already read", () => {
    expect(inches('8"')).toBe(8);
    expect(inches("32")).toBe(32);
    expect(inches('10.5"')).toBe(10.5);
    expect(inches("0")).toBe(0);
  });

  /* ABSENT IS NOT ZERO, and this is the distinction docs/bugs/0732 was about:
     a component nobody has picked must stay unknown rather than be summed as
     nothing. "No Leg" is a DECISION; blank is not. */
  it("keeps saying nothing when the ERP says nothing", () => {
    expect(inches(null)).toBeNull();
    expect(inches("")).toBeNull();
    expect(inches("TBC")).toBeNull();
    expect(inches("KIV")).toBeNull();
  });

  it("closes the leg axis on HC-SO-2609-005 and opens nothing", () => {
    /* both sides say there is no leg */
    expect(verdictOf(0, inches("No Leg"), (a, b) => a === b)).toBe(AGREE);
    /* and where the book WANTS a leg the ERP does not have, that stays a real
       finding rather than being hidden as a blank */
    expect(verdictOf(1, inches("No Leg"), (a, b) => a === b)).not.toBe(ERP_BLANK);
  });
});
