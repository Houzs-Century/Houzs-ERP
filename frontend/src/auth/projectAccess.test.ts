
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
    const a = readProjectAccess({
      _access: { level: "full", pms: { role: "SALES" } },
    });
    for (const flag of FLAGS) {
      if (flag === "full") continue;
      expect(a[flag], `${flag} defaulted to true on an omitted flag`).toBe(false);
    }
  });

  for (const bogus of [1, "true", "yes", {}, [], "1"]) {
    test(`a non-boolean truthy value (${JSON.stringify(bogus)}) is NOT a grant`, () => {
      const a = readProjectAccess({
        _access: { level: "full", pms: { canPayment: bogus as unknown as boolean } },
      });
      expect(a.canPayment).toBe(false);
    });
  }

  test("`full` reflects the ROW tier and is NOT ored into any section flag", () => {
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
    expect(projectAccessUnresolved(null)).toBe(false);
    expect(projectAccessUnresolved(undefined)).toBe(false);
  });

  test("a complete payload is resolved", () => {
    expect(
      projectAccessUnresolved({ _access: { level: "full", pms: { role: "DIRECTOR" } } }),
    ).toBe(false);
  });
});

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
      const BANNED = [
        "canPayment ?? true",
        "canEdit !== false",
        '_access?.level ?? "full"',
        "pms ? pms.canFinancial : fullAccess",
        "!detail.data?._access ||",
      ];
      const live = stripComments(text);
      for (const pattern of BANNED) {
        expect(live, `${pattern} is live again in ${file}`).not.toContain(pattern);
      }
    });
  }
});
