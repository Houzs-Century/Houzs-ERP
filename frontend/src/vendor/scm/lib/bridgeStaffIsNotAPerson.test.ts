// ----------------------------------------------------------------------------
// The 2990 auth bridge answers ONE question, and it is not "who is this".
//
// `vendor/scm/lib/auth.ts` exists so the MRP page can ask
// `isAdminLevel(staff?.role)` without dragging 2990's supabase-coupled
// AuthProvider into Houzs. It maps a Houzs permission to a 2990 role and
// returns a staff object whose every OTHER field is a hard-coded null:
//
//     return { staff: { id: null, role, name: null, staffCode: null, venueId: null } };
//
// That is documented in the file. It is also very easy to read past, because
// `useAuth().staff` is never null — only its fields are — so every truthiness
// check on it passes and every optional chain silently yields null.
//
// ConsignmentOrderNew read past it twice (2026-08-21):
//   · `if (!currentStaff?.id) return;` guarded the salesperson seed, so the
//     seed could never fire and the field was never filled in;
//   · the non-admin branch of the Salesperson picker built its single option
//     from `currentStaff`, rendering the literal text **"null (null)"** with an
//     empty value.
// SalesOrderNew and SalesOrderDetail pass the same fields into
// `resolveSelfStaff` as ONE RUNG of a ladder that also carries the real Houzs
// user, so the nulls just miss and the ladder falls through. That is the
// correct use, and it is why they never showed the symptom.
//
// Two tests: the bridge's contract, and that nobody renders a person out of it.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stripComments } from "../../../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));
const feSrc = (rel: string) =>
  stripComments(readFileSync(resolve(HERE, "..", "..", "..", rel), "utf8"));

/* Every page that takes `staff` off the bridge. Adding one here is cheap;
   forgetting to is how the two defects above shipped. */
const BRIDGE_CONSUMERS = [
  "pages/scm-v2/ConsignmentOrderNew.tsx",
  "pages/scm-v2/SalesOrderNew.tsx",
  "pages/scm-v2/SalesOrderDetail.tsx",
] as const;

describe("the bridge names nobody", () => {
  /* Source-scanned rather than called: useAuth is a hook over Houzs's own
     AuthContext, and mounting a provider to re-read a hard-coded literal would
     test the harness. What must not drift is the LITERAL. */
  const src = feSrc("vendor/scm/lib/auth.ts");

  test.each(["id", "name", "staffCode", "venueId"])(
    "staff.%s is a hard-coded null in the returned object",
    (field) => {
      const returned = src.match(/return \{ staff: \{([^}]*)\}/)?.[1] ?? "";
      expect(returned).toMatch(new RegExp(`${field}:\\s*null`));
    },
  );

  test("role is the ONLY field it actually computes", () => {
    const returned = src.match(/return \{ staff: \{([^}]*)\}/)?.[1] ?? "";
    const computed = returned
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !/:\s*null$/.test(p));
    expect(computed).toEqual(["role"]);
  });
});

describe("no page renders a person out of the bridge", () => {
  /* The exact shape that produced "null (null)": a template literal built from
     the bridge staff's name and code. Asserting on the MATCH, not the file, so
     a failure prints the offending snippet instead of a 2,000-line component. */
  test.each(BRIDGE_CONSUMERS)("%s does not label anything from currentStaff", (rel) => {
    const hit = feSrc(rel).match(/\$\{currentStaff[.?]/)?.[0] ?? null;
    expect(hit).toBeNull();
  });

  /* A seed gated on the bridge's id is dead code that reads as a feature. The
     legitimate use is passing it INTO resolveSelfStaff as one rung, which never
     takes this shape. */
  test.each(BRIDGE_CONSUMERS)("%s does not gate a seed on currentStaff?.id", (rel) => {
    const hit = feSrc(rel).match(/if\s*\(\s*!currentStaff\?\.id\s*\)/)?.[0] ?? null;
    expect(hit).toBeNull();
  });

  /* Whoever a document is attributed to must come from the shared ladder, which
     starts at the REAL Houzs user. Each of these pages picks a salesperson. */
  test.each(BRIDGE_CONSUMERS)("%s resolves its person through resolveSelfStaff", (rel) => {
    expect(feSrc(rel)).toContain("resolveSelfStaff(");
  });
});
