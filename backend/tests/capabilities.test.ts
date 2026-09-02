// ----------------------------------------------------------------------------
// capabilities — the AGREEMENT suite.
//
// The registry's whole value is the claim that a capability cannot disagree with
// the gate it describes. That claim has to be MECHANISED, not asserted in a
// comment, because the comment is exactly what was already there when the drift
// happened: SalesOrderMaintenance.tsx carried a docblock explaining that
// `scm.config.write` was the right key, while the gate had grown a second term.
//
// So every test below runs the CAPABILITY and the LIVE BACKEND GATE over the
// same caller and pins the two equal — over every position in the live prod
// snapshot, not over a hand-picked three. If someone widens a gate and forgets
// the capability (or the reverse), a position falls out of alignment and CI says
// which one.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import {
  CAPABILITY_KEYS,
  resolveCapabilities,
  hasCapability,
  type CapabilityCaller,
  type CapabilityKey,
} from "../src/services/capabilities";
import { POSITION_ACCESS_SNAPSHOT } from "../src/services/positionAccessSnapshot";
import {
  isDirectorUser,
  isFinanceViewer,
  isProductCostViewer,
  isSalesDirectorUser,
  isSalesUser,
} from "../src/services/pmsAccess";
import { moneyWriteDenial, resolvePositionPolicy } from "../src/services/positionPolicy";
import { fairReportAccess } from "../src/scm/lib/fair-report";
import { hasPermission } from "../src/services/permissions";
import type { AuthUser } from "../src/services/auth";

/* ── The caller matrix ──────────────────────────────────────────────────────
   Every live prod position, crossed with the three permission shapes that
   change an answer: no flat grants, the `*` wildcard, and each of the flat keys
   a capability reads. Plus the shapes that are NOT positions at all — the
   positionless legacy user and the unidentifiable caller — because those are
   where fail-open bugs live. */

const FLAT_KEYS_UNDER_TEST = ["scm.config.write", "scm.so.view_all"] as const;

interface NamedCaller {
  label: string;
  caller: CapabilityCaller;
}

const CALLERS: NamedCaller[] = [];

for (const p of POSITION_ACCESS_SNAPSHOT) {
  CALLERS.push({
    label: `${p.name} — no flat grants`,
    caller: { position_name: p.name, department_name: p.department_name, permissions: [] },
  });
  CALLERS.push({
    label: `${p.name} — wildcard`,
    caller: { position_name: p.name, department_name: p.department_name, permissions: ["*"] },
  });
  for (const k of FLAT_KEYS_UNDER_TEST) {
    CALLERS.push({
      label: `${p.name} — holds ${k}`,
      caller: { position_name: p.name, department_name: p.department_name, permissions: [k] },
    });
  }
}

// Positionless / unidentifiable shapes — the legacy role-matrix user and the
// caller whose org fields never hydrated.
CALLERS.push({ label: "positionless, no grants", caller: { permissions: [] } });
CALLERS.push({ label: "positionless, wildcard", caller: { permissions: ["*"] } });
CALLERS.push({
  label: "positionless, Sales department",
  caller: { department_name: "Sales Department", permissions: [] },
});
CALLERS.push({ label: "empty caller object", caller: {} });

/** The registry reads only these fields; the live gates take an AuthUser. This
 *  is the same adapter capabilities.ts uses internally, restated here so the
 *  test feeds the GATE independently rather than through the code under test. */
function asAuthUser(u: CapabilityCaller): AuthUser {
  return {
    position_name: u.position_name ?? null,
    department_name: u.department_name ?? null,
    permissions_set: u.permissions_set ?? new Set(u.permissions ?? []),
  } as unknown as AuthUser;
}

/* ── The gate side of each pairing ──────────────────────────────────────────
   Each entry re-expresses the LIVE gate independently of capabilities.ts. Where
   the gate takes a Hono context (scm/lib/houzs-perms), it is restated over the
   same inputs the context would have supplied — houzsUser's permissions_set,
   position_name and department_name, which scm/middleware/auth.ts mirrors for
   exactly these checks. */

const GATES: Record<CapabilityKey, (u: CapabilityCaller) => boolean> = {
  // houzs-perms.canWriteScmConfig
  "scm.config.write": (u) =>
    hasPermission(u.permissions_set ?? u.permissions ?? [], "scm.config.write") ||
    resolvePositionPolicy({
      position_name: u.position_name ?? null,
      department_name: u.department_name ?? null,
    }).flags.canWriteConfig,

  // houzs-perms.canViewScmFinance
  "scm.finance.view": (u) => isFinanceViewer(asAuthUser(u)),

  // houzs-perms.canViewScmProductCost
  "scm.productCost.view": (u) => isProductCostViewer(asAuthUser(u)),

  // houzs-perms.canViewAllSales
  "scm.sales.viewAll": (u) =>
    hasPermission(u.permissions_set ?? u.permissions ?? [], "scm.so.view_all") ||
    isDirectorUser(asAuthUser(u)),

  // area-guard's money rule: a null denial reason IS the grant.
  "scm.money.move": (u) =>
    moneyWriteDenial(
      {
        permissions: u.permissions,
        permissions_set: u.permissions_set,
        position_name: u.position_name ?? null,
      },
      "scm.finance.accounting",
      "POST",
    ) === null,

  "fair.so.view": (u) => fairReportAccess("so", asAuthUser(u)).allowed,
  "fair.do.view": (u) => fairReportAccess("do", asAuthUser(u)).allowed,
  "fair.invoice.view": (u) => fairReportAccess("invoice", asAuthUser(u)).allowed,

  // "open the report at all" = allowed on ANY stage. Stated as the explicit OR of
  // the three stages (not the code's FAIR_STAGES.some) so this is an independent
  // re-expression of the rule, not a copy of the implementation.
  "fair.report.view": (u) =>
    fairReportAccess("so", asAuthUser(u)).allowed ||
    fairReportAccess("do", asAuthUser(u)).allowed ||
    fairReportAccess("invoice", asAuthUser(u)).allowed,

  "org.sales.staff": (u) => isSalesUser(asAuthUser(u)),
  "org.director": (u) => isDirectorUser(asAuthUser(u)),
  "org.salesDirector": (u) => isSalesDirectorUser(asAuthUser(u)),

  // The composed page-open tier — union of the write gate and the read tier.
  "scm.maintenance.open": (u) =>
    GATES["scm.config.write"](u) || GATES["org.director"](u),
};

describe("capabilities — every key answers exactly what its backend gate answers", () => {
  test("the registry and the GATES table cover the same key set", () => {
    // If this fails, someone added a capability without pairing it to a gate —
    // which is how a capability becomes a UI hint with nothing behind it.
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(GATES).sort());
  });

  for (const key of Object.keys(GATES) as CapabilityKey[]) {
    test(`${key} agrees with its gate for every caller in the matrix`, () => {
      const disagreements: string[] = [];
      for (const { label, caller } of CALLERS) {
        const fromCapability = resolveCapabilities(caller)[key];
        const fromGate = GATES[key](caller);
        if (fromCapability !== fromGate) {
          disagreements.push(
            `${label}: capability=${fromCapability} gate=${fromGate}`,
          );
        }
      }
      expect(disagreements).toEqual([]);
    });
  }

  test("hasCapability matches resolveCapabilities for every key and caller", () => {
    for (const { caller } of CALLERS) {
      const set = resolveCapabilities(caller);
      for (const key of CAPABILITY_KEYS) {
        expect(hasCapability(caller, key)).toBe(set[key]);
      }
    }
  });
});

describe("capabilities — fails CLOSED", () => {
  test("a null caller denies EVERY capability", () => {
    const set = resolveCapabilities(null);
    for (const key of CAPABILITY_KEYS) expect(set[key]).toBe(false);
  });

  test("an undefined caller denies EVERY capability", () => {
    const set = resolveCapabilities(undefined);
    for (const key of CAPABILITY_KEYS) expect(set[key]).toBe(false);
  });

  test("hasCapability denies on a null caller", () => {
    for (const key of CAPABILITY_KEYS) expect(hasCapability(null, key)).toBe(false);
  });

  test("the denial set is FULLY POPULATED, never an empty object", () => {
    // An empty map is the fail-open shape: a client reading `caps[key]` off `{}`
    // gets `undefined`, and `undefined` is one careless `?? true` away from a
    // grant. Every key must be present and must be a real boolean.
    const set = resolveCapabilities(null);
    expect(Object.keys(set).sort()).toEqual([...CAPABILITY_KEYS].sort());
    for (const key of CAPABILITY_KEYS) expect(typeof set[key]).toBe("boolean");
  });

  test("every resolved value is a strict boolean, never a truthy proxy", () => {
    for (const { caller } of CALLERS) {
      const set = resolveCapabilities(caller);
      for (const key of CAPABILITY_KEYS) expect(typeof set[key]).toBe("boolean");
    }
  });

  test("the denial set is a fresh object — a consumer cannot mutate a shared deny into a grant", () => {
    const a = resolveCapabilities(null) as Record<CapabilityKey, boolean>;
    a["org.director"] = true;
    expect(resolveCapabilities(null)["org.director"]).toBe(false);
  });
});

describe("scm.maintenance.open — the divergence this PR closes", () => {
  /** Build the caller for a named snapshot position, with no flat grants — the
   *  ordinary case, where the position alone must decide. */
  function positioned(name: string): CapabilityCaller {
    const row = POSITION_ACCESS_SNAPSHOT.find((p) => p.name === name);
    if (!row) throw new Error(`position not in snapshot: ${name}`);
    return { position_name: row.name, department_name: row.department_name, permissions: [] };
  }

  // The four frontend sites gated this page on isDirectorUser ALONE. These are
  // the positions that gap admitted or excluded WRONGLY.
  const CONFIG_POSITIONS = [
    "Procurement/Purchasing",
    "Operation Manager",
    "Operation Executive",
    "Logistic Admin",
  ];

  for (const name of CONFIG_POSITIONS) {
    test(`${name} may OPEN maintenance — the old isDirectorUser gate bounced them`, () => {
      const u = positioned(name);
      // The old frontend predicate.
      expect(isDirectorUser(asAuthUser(u))).toBe(false);
      // What the API actually allows — and now what the capability says.
      expect(GATES["scm.config.write"](u)).toBe(true);
      expect(resolveCapabilities(u)["scm.maintenance.open"]).toBe(true);
      expect(resolveCapabilities(u)["scm.config.write"]).toBe(true);
    });
  }

  /* Owner 2026-09-01 — the Sales Director now MAINTAINS product master data
     (retail price, sofa combos, Model activation / Modular toggles), so the page
     he could already open is no longer read-only for him. Finance Manager below
     is the unchanged read-only case, and is why this test is not simply deleted:
     "opens but cannot write" is still a real state, just not his. */
  test("Sales Director opens the page AND may write config", () => {
    const u = positioned("Sales Director");
    expect(resolveCapabilities(u)["scm.maintenance.open"]).toBe(true);
    expect(resolveCapabilities(u)["scm.config.write"]).toBe(true);
  });

  test("Finance Manager opens the page READ-ONLY", () => {
    const u = positioned("Finance Manager");
    expect(resolveCapabilities(u)["scm.maintenance.open"]).toBe(true);
    expect(resolveCapabilities(u)["scm.config.write"]).toBe(false);
  });

  test("Super Admin both opens and writes", () => {
    const u = positioned("Super Admin");
    expect(resolveCapabilities(u)["scm.maintenance.open"]).toBe(true);
    expect(resolveCapabilities(u)["scm.config.write"]).toBe(true);
  });

  for (const name of ["Sales Manager", "Sales Executive", "Sales Person"]) {
    test(`${name} stays OUT — the owner's 2026-07-15 ruling is not weakened`, () => {
      const u = positioned(name);
      expect(resolveCapabilities(u)["scm.maintenance.open"]).toBe(false);
    });
  }

  for (const name of ["Driver", "Helper", "Storekeeper"]) {
    test(`${name} stays OUT`, () => {
      const u = positioned(name);
      expect(resolveCapabilities(u)["scm.maintenance.open"]).toBe(false);
    });
  }

  test("the new gate is ADDITIVE — nobody who could open the page loses it", () => {
    // Formally: for every caller in the matrix, old ⇒ new.
    for (const { label, caller } of CALLERS) {
      const oldGate = isDirectorUser(asAuthUser(caller));
      if (oldGate) {
        expect(
          resolveCapabilities(caller)["scm.maintenance.open"],
          `${label} could open the page before and must still be able to`,
        ).toBe(true);
      }
    }
  });
});
