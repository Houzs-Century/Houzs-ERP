import { describe, it, expect } from "vitest";
import {
  PAGES,
  resolvePositionAccessFromRows,
  type AccessLevel,
} from "../src/services/pageAccess";
import { resolveMemberPageAccess } from "../src/services/memberPageAccess";
import { resolvePositionPolicy } from "../src/services/positionPolicy";
import { applySalesJdOverride } from "../src/services/salesJdAccess";
import { policyRowFromDb } from "../src/services/positionPolicyRows";

// ---------------------------------------------------------------------------
// The NO-OP cutover proof for the RBAC rebuild (PR1). Page access moves from the
// login-time derivation (resolvePositionPolicy for a titled member, the
// permission backfill for a title-less one) to the persistent role_page_access
// rows. This asserts, for every real (role, position) combination in production
// on 2026-10-20, that resolving from the SEEDED rows is byte-identical to the
// live derivation it replaces — money/stock pages explicitly included.
//
// WHY IT IS NOT TAUTOLOGICAL. The seed is the live base written as one explicit
// row per page; this proves three things a future change could break: (1)
// resolvePositionAccessFromRows round-trips a fully-explicit map without the
// parent/child cascade mutating a cell, (2) every catalogue page is covered so
// nothing silently defaults to "none" (the lockout direction), and (3) the
// concrete money/stock levels each cohort holds today still hold after the
// cutover. scm_l2_configured is asserted to stay a NON-page output of the
// position policy — NOT re-derived from the seeded rows, which would flip the
// full cohort and trip scmAreaGuard.
// ---------------------------------------------------------------------------

type PolicyDb = {
  cohort: string;
  profile: string | null;
  can_move_money: number;
  can_write_config: number;
  is_fleet: number;
  duty: string;
};

interface Combo {
  label: string;
  perms: string[];
  positionId: number | null;
  positionName: string | null;
  departmentName: string | null;
  policyDb: PolicyDb | null;
}

// Every active (role, position) combination measured in prod (anogrigyjbduyzclzjgn)
// on 2026-10-20 — this is role/position metadata, not user data.
const COMBOS: Combo[] = [
  {
    label: "Owner role (* ) / Owner (god)",
    perms: ["*", "agreement.approve"],
    positionId: 21, positionName: "Owner", departmentName: "Management",
    policyDb: { cohort: "god", profile: null, can_move_money: 1, can_write_config: 1, is_fleet: 0, duty: "management" },
  },
  {
    label: "Super Admin role (* ) / Super Admin (god)",
    perms: ["*"],
    positionId: 1, positionName: "Super Admin", departmentName: "Management",
    policyDb: { cohort: "god", profile: null, can_move_money: 1, can_write_config: 1, is_fleet: 0, duty: "management" },
  },
  {
    label: "Super Admin role (* ) / no position",
    perms: ["*"],
    positionId: null, positionName: null, departmentName: null, policyDb: null,
  },
  {
    label: "Driver role / Driver (restricted, driver_helper, fleet)",
    perms: ["projects.checklist.tick"],
    positionId: 16, positionName: "Driver", departmentName: "Operation Department",
    policyDb: { cohort: "restricted", profile: "driver_helper", can_move_money: 0, can_write_config: 0, is_fleet: 1, duty: "driver" },
  },
  {
    label: "Helper role / Warehouse Crew KL (restricted, storekeeper)",
    perms: ["projects.checklist.tick", "projects.read"],
    positionId: 24, positionName: "Warehouse Crew KL", departmentName: "Operation Department",
    policyDb: { cohort: "restricted", profile: "storekeeper", can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "warehouse" },
  },
  {
    label: "Storekeeper role / Storekeeper Supervisor (restricted, supervisor)",
    perms: ["projects.checklist.tick", "projects.read", "scm.access", "scm.payment_request.create"],
    positionId: 19, positionName: "Storekeeper Supervisor", departmentName: "Operation Department",
    policyDb: { cohort: "restricted", profile: "storekeeper_supervisor", can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "other" },
  },
  {
    label: "Sales Person role / Sales Executive (sales, rep)",
    perms: ["service_cases.read", "sales.read", "sales.write", "sales.manage", "projects.read"],
    positionId: 7, positionName: "Sales Executive", departmentName: "Sales Department",
    policyDb: { cohort: "sales", profile: "rep", can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "other" },
  },
  {
    label: "Sales Director role / Sales Director (sales, director)",
    perms: ["projects.read", "sales.read", "sales.write", "scm.amendment.approve_price"],
    positionId: 5, positionName: "Sales Director", departmentName: "Sales Department",
    policyDb: { cohort: "sales", profile: "director", can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "other" },
  },
  {
    label: "Marketing role / Sales Director (sales, director)",
    perms: ["sales.read", "sales.write", "sales.manage"],
    positionId: 5, positionName: "Sales Director", departmentName: "Sales Department",
    policyDb: { cohort: "sales", profile: "director", can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "other" },
  },
  {
    label: "Finance Executive role / Finance Executive (full, money)",
    perms: ["projects.finance.view", "projects.read", "scm.access", "scm.payment_voucher.post", "scm.so.view_all"],
    positionId: 28, positionName: "Finance Executive", departmentName: "Finance Department",
    policyDb: { cohort: "full", profile: null, can_move_money: 1, can_write_config: 0, is_fleet: 0, duty: "finance" },
  },
  {
    label: "IT Admin role / IT Developer Executive (full)",
    perms: ["projects.manage", "users.manage", "roles.manage", "sales.manage", "service_cases.manage", "settings.manage", "scm.access", "scm.config.write"],
    positionId: 22, positionName: "IT Developer Executive", departmentName: "IT Department",
    policyDb: { cohort: "full", profile: null, can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "other" },
  },
  {
    label: "Purchaser role / Operation Executive (full, config)",
    perms: ["projects.read", "scm.access", "scm.amendment.approve_so", "scm.product_request.approve", "scm.so.view_all", "service_cases.manage"],
    positionId: 12, positionName: "Operation Executive", departmentName: "Operation Department",
    policyDb: { cohort: "full", profile: null, can_move_money: 0, can_write_config: 1, is_fleet: 0, duty: "other" },
  },
  {
    label: "Logistic Admin role / Logistic Admin (full, config)",
    perms: ["fleet.read", "projects.read", "sales.read", "scm.access", "scm.amendment.approve_delivery", "scm.so.view_all"],
    positionId: 14, positionName: "Logistic Admin", departmentName: "Operation Department",
    policyDb: { cohort: "full", profile: null, can_move_money: 0, can_write_config: 1, is_fleet: 0, duty: "other" },
  },
  {
    label: "HR role / HR Manager (full)",
    perms: ["announcements.read", "mail_center.read", "roles.read", "scm.hr.manage", "users.manage", "users.read"],
    positionId: 2, positionName: "HR Manager", departmentName: "HR Department",
    policyDb: { cohort: "full", profile: null, can_move_money: 0, can_write_config: 0, is_fleet: 0, duty: "other" },
  },
  {
    label: "New Member (no access) role / Driver (restricted)",
    perms: [],
    positionId: 16, positionName: "Driver", departmentName: "Operation Department",
    policyDb: { cohort: "restricted", profile: "driver_helper", can_move_money: 0, can_write_config: 0, is_fleet: 1, duty: "driver" },
  },
  {
    // No active member holds a title-less non-`*` role in prod today, so this is
    // latent — but it is the one path where the seed could flip
    // scm_l2_configured (the `scm.*=none` rows would mark the member
    // scm-configured if scm_l2 were taken from resolvePositionAccessFromRows's
    // meta). `scm.access` is a PERMISSION, not a page key, so the seed's scm*
    // rows are all `none`; scm_l2 must stay false across the no-op seed.
    label: "Title-less role with scm.access / no position",
    perms: ["scm.access", "projects.read", "sales.read"],
    positionId: null, positionName: null, departmentName: "Operation Department",
    policyDb: null,
  },
];

const PAGE_KEYS = PAGES.map((p) => p.key);

function ctxFor(c: Combo) {
  const positionPolicy = policyRowFromDb(
    c.policyDb ? { position_id: c.positionId, ...c.policyDb } : null,
  );
  return {
    permissionsSet: new Set(c.perms),
    positionId: c.positionId,
    positionName: c.positionName,
    departmentName: c.departmentName,
    positionPolicy,
  };
}

/** Final page access = base + applySalesJdOverride — what login attaches. */
function finalWithRows(c: Combo, roleRows: Array<{ page_key: string; level: string }>) {
  const ctx = ctxFor(c);
  const base = resolveMemberPageAccess({ ...ctx, roleRows }).pageAccess;
  return applySalesJdOverride(base, {
    permissions: ctx.permissionsSet,
    position_name: c.positionName,
    department_name: c.departmentName,
    position_policy: ctx.positionPolicy,
  });
}

/** The role's seed = the live base written as one explicit row per page. */
function seedRowsFor(c: Combo): Array<{ page_key: string; level: string }> {
  const base = resolveMemberPageAccess({ ...ctxFor(c), roleRows: [] }).pageAccess;
  return PAGE_KEYS.map((k) => ({ page_key: k, level: base[k] }));
}

describe("role_page_access cutover is a byte-for-byte no-op", () => {
  for (const c of COMBOS) {
    it(`${c.label}: seeded rows resolve identically to the live policy`, () => {
      const ctx = ctxFor(c);
      const legacy = resolveMemberPageAccess({ ...ctx, roleRows: [] });
      const seeded = resolveMemberPageAccess({ ...ctx, roleRows: seedRowsFor(c) });

      // Every catalogue page round-trips exactly — no cell lost to the cascade,
      // no page left to default "none".
      for (const k of PAGE_KEYS) {
        expect(seeded.pageAccess[k], `${c.label} page ${k}`).toBe(legacy.pageAccess[k]);
      }

      // End-to-end, with applySalesJdOverride on top (what hydrateAuthUser does).
      expect(finalWithRows(c, seedRowsFor(c))).toEqual(finalWithRows(c, []));

      // scm_l2_configured stays a non-page output: identical whether or not the
      // role has rows.
      expect(seeded.scmL2Configured).toBe(legacy.scmL2Configured);
    });
  }

  it("an UNSEEDED role (no rows) resolves to exactly the previous derivation", () => {
    for (const c of COMBOS) {
      const ctx = ctxFor(c);
      const fallback = resolveMemberPageAccess({ ...ctx, roleRows: [] });
      if (c.perms.includes("*")) {
        // The wildcard short-circuit — never read rows, always full.
        for (const k of PAGE_KEYS) expect(fallback.pageAccess[k]).toBe("full");
        expect(fallback.scmL2Configured).toBe(false);
      } else if (c.positionId != null) {
        // A titled member falls back to the position policy, verbatim.
        const policy = resolvePositionPolicy(
          { position_name: c.positionName, department_name: c.departmentName },
          ctx.positionPolicy,
        );
        for (const k of PAGE_KEYS) expect(fallback.pageAccess[k]).toBe(policy.pageAccess[k]);
        expect(fallback.scmL2Configured).toBe(policy.scmConfigured);
      }
    }
  });

  it("a title-less member's scm_l2_configured survives a no-op seed, and flips only on a real scm grant", () => {
    const c = COMBOS.find((x) => x.label.startsWith("Title-less"))!;
    const ctx = ctxFor(c);
    // Unseeded (today) and after the no-op seed (scm.* all 'none') must agree —
    // false — or scmAreaGuard would start enforcing on a member whose pageAccess
    // map did not change.
    expect(resolveMemberPageAccess({ ...ctx, roleRows: [] }).scmL2Configured).toBe(false);
    expect(resolveMemberPageAccess({ ...ctx, roleRows: seedRowsFor(c) }).scmL2Configured).toBe(false);
    // Only a real grant — an scm sub-area at a level other than none — flips it.
    const granted = seedRowsFor(c).map((r) =>
      r.page_key === "scm.warehouse.inventory" ? { ...r, level: "view" } : r);
    expect(resolveMemberPageAccess({ ...ctx, roleRows: granted }).scmL2Configured).toBe(true);
  });
});

describe("money/stock pages keep their exact level across the cutover", () => {
  const levelOf = (label: string, key: string): AccessLevel => {
    const c = COMBOS.find((x) => x.label.startsWith(label))!;
    return resolveMemberPageAccess({ ...ctxFor(c), roleRows: seedRowsFor(c) }).pageAccess[key];
  };

  it("Finance keeps WRITE on the GL / payment-voucher page", () => {
    // can_move_money → the finance areas stay full (write allowed), not lowered.
    expect(levelOf("Finance Executive", "scm.finance.accounting")).toBe("full");
    expect(levelOf("Finance Executive", "scm.finance.outstanding")).toBe("full");
  });

  it("a full non-finance position SEES finance but cannot write (view, not edit/full)", () => {
    expect(levelOf("IT Admin", "scm.finance.accounting")).toBe("view");
    expect(levelOf("HR role", "scm.finance.accounting")).toBe("view");
    expect(levelOf("Purchaser", "scm.finance.accounting")).toBe("view");
  });

  it("a Storekeeper may VIEW inventory but every stock-mutating write stays denied", () => {
    expect(levelOf("Storekeeper role", "scm.warehouse.inventory")).toBe("view");
    expect(levelOf("Storekeeper role", "scm.warehouse.transfers")).toBe("none");
    expect(levelOf("Storekeeper role", "scm.warehouse.stock_take")).toBe("none");
    expect(levelOf("Storekeeper role", "scm.warehouse.adjustments")).toBe("none");
  });

  it("a Driver gets the delivery board but no warehouse", () => {
    expect(levelOf("Driver role", "scm.transportation")).toBe("view");
    expect(levelOf("Driver role", "scm.warehouse")).toBe("none");
    expect(levelOf("Driver role", "scm.warehouse.inventory")).toBe("none");
  });

  it("the wildcard keeps full on every money/stock page", () => {
    for (const key of ["scm.finance.accounting", "scm.warehouse.inventory", "scm.warehouse.adjustments"]) {
      expect(levelOf("Owner role", key)).toBe("full");
    }
  });
});
