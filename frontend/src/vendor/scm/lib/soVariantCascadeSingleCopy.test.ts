// ----------------------------------------------------------------------------
// so-variant-cascade — there is ONE copy of the rule, and the pages wire to it.
//
// The rule "line 1 of a category drives the later lines" was hand-written four
// times, and all four drifted. #2637 converted two of them (SalesOrderNew,
// MobileNewSO) while its own header claimed all four; ConsignmentOrderNew was
// still running its own version a merge later, with `overriddenKeys` vetoing
// the cascade (a follower touched once was sticky forever — the opposite of
// the owner's 2026-08-21 「第一个沙发再改就拉回去」), with `buildKey` inherited
// like any other key, and with `remark` cascading category-wide.
//
// A fifth copy is how that happens again, so the shape is pinned here rather
// than trusted to review. Source-scanning for the reason
// permissionDivergence.test.ts states: rendering these pages would couple this
// test to routers, query clients and lazy boundaries, and break for reasons
// that have nothing to do with the rule. What must not drift is WHERE the rule
// comes from — which is exactly what the source says.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stripComments } from "../../../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) =>
  stripComments(readFileSync(resolve(HERE, "..", "..", "..", rel), "utf8"));

/* Assert on the MATCH, never on the file. `expect(wholeFile).not.toMatch(...)`
   prints the entire component on failure, which buries the finding. */
const hit = (rel: string, re: RegExp): string | null => src(rel).match(re)?.[0] ?? null;

/* The pages that RUN the cascade. DeliveryOrderNewV2 is deliberately absent:
   it seeds at pick time and never follows, and whether a delivery-order line
   should follow line 1 at all is an owner decision, not a defect. When that is
   answered, add it here — the guard below then holds it to the same rule. */
const CASCADING_PAGES = [
  "pages/scm-v2/SalesOrderNew.tsx",
  "pages/scm-v2/ConsignmentOrderNew.tsx",
  "mobile/MobileNewSO.tsx",
] as const;

/* Every page that seeds a new line from its category's first line, cascading
   or not — they must all take the seed from the shared module so a fresh line
   never inherits another sofa's build identity or its remark. */
const SEEDING_PAGES = [
  ...CASCADING_PAGES,
  "pages/scm-v2/DeliveryOrderNewV2.tsx",
] as const;

describe("the cascade rule has exactly one home", () => {
  test.each(CASCADING_PAGES)("%s imports the shared module", (rel) => {
    expect(src(rel)).toContain("so-variant-cascade");
  });

  test.each(CASCADING_PAGES)("%s calls cascadeMasterVariants", (rel) => {
    expect(src(rel)).toContain("cascadeMasterVariants(");
  });

  /* The hand-written copies all built this map to find the master. Its
     presence in a page IS the second copy — the shared module owns that
     question (masterVariantsByCategory). */
  test.each(CASCADING_PAGES)("%s carries no hand-written master map", (rel) => {
    expect(hit(rel, /masterByCategory/)).toBeNull();
    expect(hit(rel, /masterIdx/)).toBeNull();
  });

  /* The specific drift that made ConsignmentOrderNew unfixable-by-line-1: a
     follower key listed in overriddenKeys was skipped, forever. The shared
     module answers this with the master snapshot instead. `overriddenKeys`
     still legitimately guards the per-sofa colour sync in updateLine, so this
     asserts the VETO shape, not the identifier. */
  test.each(CASCADING_PAGES)("%s has no overriddenKeys veto on the cascade", (rel) => {
    expect(hit(rel, /overridden\.has\(\s*k\s*\)/)).toBeNull();
    expect(hit(rel, /new Set\(\s*l\.overriddenKeys/)).toBeNull();
  });
});

describe("a new line's seed comes from the shared module", () => {
  test.each(SEEDING_PAGES)("%s uses seedableMasterVariants", (rel) => {
    expect(src(rel)).toContain("seedableMasterVariants(");
  });

  /* The hand-rolled memo every page carried. It differs from the shared one in
     the way that matters: it hands over `buildKey` and `remark` unfiltered. */
  test.each(SEEDING_PAGES)("%s carries no hand-written seed memo", (rel) => {
    expect(hit(rel, /if\s*\(\s*!cat\s*\|\|\s*out\[cat\]\s*\)\s*continue/)).toBeNull();
  });
});
