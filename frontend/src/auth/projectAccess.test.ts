// ----------------------------------------------------------------------------
// projectAccess — the FAIL-CLOSED suite.
//
// The value of this module is one claim: an absent permission payload means NO.
// That claim has to be MECHANISED, because the five call sites it replaced were
// each written by someone who believed they were being careful — every one of
// them carried a comment explaining that the fallback was for "older cached
// responses", and every one of them granted access instead.
//
// So this file enumerates the ways a payload can be missing or partial and pins
// the answer to false for each, then pins the call sites themselves to the
// reader so a future edit cannot quietly reintroduce a default.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  readProjectAccess,
  projectAccessUnresolved,
  denyProjectAccess,
  type ProjectAccess,
  type ProjectAccessCarrier,
} from "./projectAccess";
import { stripComments } from "./sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

/** Every boolean the reader answers. Enumerated rather than derived so that
 *  ADDING a flag to ProjectAccess without adding it here fails to compile. */
const FLAGS = [
  "full",
  "canEdit",
  "canFinancial",
  "canRental",
  "canPayment",
  "canSensitive",
  "canSetupDismantle",
] as const satisfies ReadonlyArray<
  keyof { [K in keyof ProjectAccess as ProjectAccess[K] extends boolean ? K : never]: true }
>;

/* ── The ways a payload goes missing ────────────────────────────────────────
   Each of these is a state the app can genuinely reach: a stale PWA shell, a
   Pages deploy ahead of the Worker, a truncated response, a hand-rolled test
   fixture, or a component rendering before its query resolves. */
const MISSING: { label: string; carrier: ProjectAccessCarrier | null | undefined }[] = [
  { label: "null carrier", carrier: null },
  { label: "undefined carrier", carrier: undefined },
  { label: "no _access at all", carrier: {} },
  { label: "_access undefined", carrier: { _access: undefined } },
  { label: "_access null", carrier: { _access: null } },
  { label: "_access with no pms", carrier: { _access: { level: "full" } } },
  { label: "_access.pms null", carrier: { _access: { level: "full", pms: null } } },
  {
    label: "level 'full' but pms absent — the exact shape the old fallbacks read as YES",
    carrier: { _access: { level: "full", is_pic: true, scoped: false } },
  },
];

describe("readProjectAccess — an absent payload is NO, never yes", () => {
  for (const { label, carrier } of MISSING) {
    test(`${label} denies EVERY flag`, () => {
      const a = readProjectAccess(carrier);
      for (const flag of FLAGS) {
        expect(a[flag], `${flag} leaked through on: ${label}`).toBe(false);
      }
    });
  }

  test("the denial is FULLY POPULATED, never a partial or empty object", () => {
    // A partial answer is what lets a call site read `undefined` as a grant.
    const a = readProjectAccess(null);
    for (const flag of FLAGS) {
      expect(a).toHaveProperty(flag);
      expect(typeof a[flag]).toBe("boolean");
    }
    expect(a.role).toBe("");
  });

  test("denyProjectAccess returns a FRESH object — a consumer cannot mutate a denial into a grant", () => {
    const a = denyProjectAccess();
    a.canPayment = true;
    expect(denyProjectAccess().canPayment).toBe(false);
  });
});

describe("readProjectAccess — a PRESENT payload is read verbatim, and only `true` is yes", () => {
  test("every flag the server set true comes back true", () => {
    const a = readProjectAccess({
      _access: {
        level: "full",
        pms: {
          role: "DIRECTOR",
          canEdit: true,
          canFinancial: true,
          canRental: true,
          canPayment: true,
          canSensitive: true,
          canSetupDismantle: true,
        },
      },
    });
    for (const flag of FLAGS) expect(a[flag]).toBe(true);
    expect(a.role).toBe("DIRECTOR");
  });

  test("a flag the server OMITTED from a present pms block is false, not true", () => {
    // This is the `pms.canPayment ?? true` case: the block arrived, the flag did
    // not. The old code granted. A permission we cannot read is NO.
    const a = readProjectAccess({
      _access: { level: "full", pms: { role: "SALES" } },
    });
    for (const flag of FLAGS) {
      if (flag === "full") continue; // `full` reads level, not a pms flag
      expect(a[flag], `${flag} defaulted to true on an omitted flag`).toBe(false);
    }
  });

  for (const bogus of [1, "true", "yes", {}, [], "1"]) {
    test(`a non-boolean truthy value (${JSON.stringify(bogus)}) is NOT a grant`, () => {
      const a = readProjectAccess({
        // deliberately ill-typed — this is what a hand-edited cache or a
        // schema drift actually looks like on the wire.
        _access: { level: "full", pms: { canPayment: bogus as unknown as boolean } },
      });
      expect(a.canPayment).toBe(false);
    });
  }

  test("`full` reflects the ROW tier and is NOT ored into any section flag", () => {
    // The Projects.tsx finance bug in one assertion: a scoped PIC is level
    // "full" on their own project and is NOT a finance viewer. If `full` ever
    // leaks into canFinancial again, this fails.
    const a = readProjectAccess({
      _access: { level: "full", is_pic: true, pms: { role: "PIC", canFinancial: false } },
    });
    expect(a.full).toBe(true);
    expect(a.canFinancial).toBe(false);
  });

  test("level 'limited' is not full", () => {
    expect(readProjectAccess({ _access: { level: "limited", pms: { role: "SALES" } } }).full).toBe(
      false,
    );
  });
});

describe("projectAccessUnresolved — names the broken-deployment state", () => {
  test("a loaded payload missing its pms block is UNRESOLVED", () => {
    expect(projectAccessUnresolved({ _access: { level: "full" } })).toBe(true);
    expect(projectAccessUnresolved({})).toBe(true);
  });

  test("a not-yet-loaded carrier is NOT unresolved — that is a skeleton, not an error", () => {
    // Getting this backwards would flash a permissions error on every load.
    expect(projectAccessUnresolved(null)).toBe(false);
    expect(projectAccessUnresolved(undefined)).toBe(false);
  });

  test("a complete payload is resolved", () => {
    expect(
      projectAccessUnresolved({ _access: { level: "full", pms: { role: "DIRECTOR" } } }),
    ).toBe(false);
  });
});

/* ── The call sites ─────────────────────────────────────────────────────────
   Source-scanning, for the same reason soMaintenanceGate.test.ts does it: these
   gates are inline in two very large components under concurrent edit, and
   rendering them would couple this test to their routers and query clients. The
   reader is unit-tested above; what must not drift is that the call sites GO
   THROUGH it and that the defaults never come back. */
describe("the call sites read the server's answer, and carry no defaults", () => {
  const SITES = ["pages/Projects.tsx", "mobile/MobilePMS.tsx"];

  for (const file of SITES) {
    test(`${file} resolves access through readProjectAccess`, () => {
      expect(src(file)).toContain("readProjectAccess(");
    });

    test(`${file} surfaces the unresolved state instead of hiding silently`, () => {
      expect(src(file)).toContain("projectAccessUnresolved(");
    });

    test(`${file} has no fail-open default left on the _access path`, () => {
      const text = src(file);
      // The five exact fallbacks this PR removed. Any of them reappearing means
      // a missing payload grants again.
      const BANNED = [
        "canPayment ?? true",
        "canEdit !== false",
        '_access?.level ?? "full"',
        "pms ? pms.canFinancial : fullAccess",
        "!detail.data?._access ||",
      ];
      // These files QUOTE the removed code in comments on purpose — that is how
      // the next reader learns what was wrong. So strip comments properly (both
      // `//` lines and `/* … */` blocks, which is what a JSX comment is) before
      // scanning, rather than weakening the patterns to dodge our own prose.
      const live = stripComments(text);
      for (const pattern of BANNED) {
        expect(live, `${pattern} is live again in ${file}`).not.toContain(pattern);
      }
    });
  }
});
