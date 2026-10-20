import { describe, it, expect } from "vitest";
import type { PermissionDef } from "../types";
import {
  MATRIX_LEVELS,
  normalizeStoredLevel,
  isNeverByLevel,
  buildMatrixModules,
  keysGrantedAtLevel,
  applyLevelToPerms,
  applyLevelToPages,
  moduleLevel,
  pageRowsToSend,
  reconcileScmAccess,
  permsDiffer,
  pageLevelsDiffCount,
  maxLevel,
  type PageLite,
  type MatrixModule,
} from "./roleMatrixModel";

// A trimmed page catalogue mirroring GET /api/roles/page-access (backend PAGES).
const PAGES: PageLite[] = [
  { key: "sales", label: "Sales Entries", parent: null },
  { key: "settings", label: "System Settings", parent: null },
  { key: "service_cases", label: "ASSR", parent: null },
  { key: "service_cases.cases", label: "Cases", parent: "service_cases" },
  { key: "service_cases.pnl", label: "P&L", parent: "service_cases", dormant: true },
  { key: "projects", label: "Projects", parent: null },
  { key: "projects.list", label: "List", parent: "projects" },
  { key: "team", label: "Team", parent: null },
  { key: "team.members", label: "Members", parent: "team", dormant: true },
  { key: "scm", label: "Supply Chain", parent: null },
  { key: "scm.sales", label: "Sales", parent: "scm" },
  { key: "scm.sales.orders", label: "Sales Orders", parent: "scm.sales" },
  { key: "scm.warehouse", label: "Warehouse", parent: "scm" },
  { key: "scm.warehouse.inventory", label: "Inventory", parent: "scm.warehouse" },
  { key: "system_health", label: "System Health", parent: null },
];

const PERMS: PermissionDef[] = [
  { key: "service_cases.read", resource: "Service Cases", verb: "read", label: "", description: "" },
  { key: "service_cases.write", resource: "Service Cases", verb: "write", label: "", description: "" },
  { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "", description: "" },
  { key: "service_cases.approve", resource: "Service Cases", verb: "manage", label: "", description: "" },
  { key: "projects.read", resource: "Projects", verb: "read", label: "", description: "" },
  { key: "projects.write", resource: "Projects", verb: "write", label: "", description: "" },
  { key: "projects.manage", resource: "Projects", verb: "manage", label: "", description: "" },
  { key: "projects.approve", resource: "Projects", verb: "manage", label: "", description: "" },
  { key: "mail_center.read", resource: "Mail Center", verb: "read", label: "", description: "" },
  { key: "mail_center.manage", resource: "Mail Center", verb: "manage", label: "", description: "" },
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "", description: "" },
  { key: "scm.so_cancel.approve_l1", resource: "Supply Chain", verb: "approve", label: "", description: "" },
  { key: "scm.payment_voucher.check", resource: "Supply Chain", verb: "manage", label: "", description: "" },
  { key: "roles.read", resource: "Roles", verb: "read", label: "", description: "" },
  { key: "roles.manage", resource: "Roles", verb: "manage", label: "", description: "" },
  { key: "users.read", resource: "Team", verb: "read", label: "", description: "" },
  { key: "users.manage", resource: "Team", verb: "manage", label: "", description: "" },
];

const modules = buildMatrixModules(PAGES, PERMS);
const mod = (id: string): MatrixModule => {
  const m = modules.find((x) => x.id === id);
  if (!m) throw new Error(`no module ${id}`);
  return m;
};

describe("normalizeStoredLevel", () => {
  it("collapses the 5-level stored vocabulary to the 4-level matrix", () => {
    expect(normalizeStoredLevel("partial")).toBe("view");
    expect(normalizeStoredLevel("view")).toBe("view");
    expect(normalizeStoredLevel("edit")).toBe("edit");
    expect(normalizeStoredLevel("full")).toBe("full");
    expect(normalizeStoredLevel("none")).toBe("none");
    expect(normalizeStoredLevel(undefined)).toBe("none");
    expect(normalizeStoredLevel("garbage")).toBe("none");
  });
});

describe("isNeverByLevel (the safety rule)", () => {
  it("excludes every approval key", () => {
    expect(isNeverByLevel("service_cases.approve")).toBe(true);
    expect(isNeverByLevel("projects.approve")).toBe(true);
    expect(isNeverByLevel("announcements.approve")).toBe(true);
    expect(isNeverByLevel("scm.so_cancel.approve_l1")).toBe(true);
    expect(isNeverByLevel("scm.so_cancel.approve_l2")).toBe(true);
    expect(isNeverByLevel("scm.amendment.approve_lines")).toBe(true);
    expect(isNeverByLevel("scm.amendment.approve_price")).toBe(true);
    expect(isNeverByLevel("scm.payment.backdate.approve")).toBe(true);
  });
  it("excludes every fine SCM key but keeps the coarse umbrella", () => {
    expect(isNeverByLevel("scm.payment_voucher.check")).toBe(true);
    expect(isNeverByLevel("scm.hr.close")).toBe(true);
    expect(isNeverByLevel("scm.so.price_override")).toBe(true);
    expect(isNeverByLevel("scm.config.write")).toBe(true);
    expect(isNeverByLevel("scm.access")).toBe(false);
  });
  it("leaves ordinary CRUD keys grantable", () => {
    expect(isNeverByLevel("projects.manage")).toBe(false);
    expect(isNeverByLevel("users.manage")).toBe(false);
    expect(isNeverByLevel("roles.manage")).toBe(false);
  });
});

describe("buildMatrixModules", () => {
  it("assigns each page to its most specific module", () => {
    expect(mod("service_cases").pages.map((p) => p.key)).toEqual([
      "service_cases",
      "service_cases.cases",
      "service_cases.pnl",
    ]);
    // scm.sales claims scm.sales + its grandchild, NOT the warehouse pages.
    expect(mod("scm.sales").pages.map((p) => p.key)).toEqual(["scm.sales", "scm.sales.orders"]);
    expect(mod("scm.warehouse").pages.map((p) => p.key)).toEqual([
      "scm.warehouse",
      "scm.warehouse.inventory",
    ]);
  });
  it("never surfaces the bare scm umbrella as its own module row", () => {
    for (const m of modules) {
      expect(m.pages.find((p) => p.key === "scm")).toBeUndefined();
    }
  });
  it("marks SCM areas and keeps their function tiers empty of fine keys", () => {
    const sales = mod("scm.sales");
    expect(sales.scmArea).toBe(true);
    expect(sales.perm.read).toEqual([]);
    expect(sales.perm.write).toEqual([]);
    expect(sales.perm.manage).toEqual([]);
  });
  it("splits a resource's keys into read/write/manage, dropping approval keys", () => {
    const sc = mod("service_cases").perm;
    expect(sc.read).toContain("service_cases.read");
    expect(sc.write).toContain("service_cases.write");
    expect(sc.manage).toContain("service_cases.manage");
    expect(sc.manage).not.toContain("service_cases.approve");
  });
  it("builds a page-less module (mail) from its resource only", () => {
    const mail = mod("mail");
    expect(mail.pages).toEqual([]);
    expect(mail.topPageKey).toBeNull();
    expect(mail.perm.read).toContain("mail_center.read");
    expect(mail.perm.manage).toContain("mail_center.manage");
  });
});

describe("keysGrantedAtLevel is monotonic and excludes approval", () => {
  it("none grants nothing; full grants read+write+manage but never approve", () => {
    const sc = mod("service_cases");
    expect([...keysGrantedAtLevel(sc, "none")]).toEqual([]);
    expect(keysGrantedAtLevel(sc, "view")).toEqual(new Set(["service_cases.read"]));
    expect(keysGrantedAtLevel(sc, "edit")).toEqual(
      new Set(["service_cases.read", "service_cases.write"]),
    );
    const full = keysGrantedAtLevel(sc, "full");
    expect(full.has("service_cases.manage")).toBe(true);
    expect(full.has("service_cases.approve")).toBe(false);
  });
});

describe("applyLevelToPerms", () => {
  it("lowering a module removes its higher-tier keys but not other modules'", () => {
    const start = new Set(["service_cases.read", "service_cases.write", "service_cases.manage", "projects.manage"]);
    const next = applyLevelToPerms(start, mod("service_cases"), "view");
    expect(next.has("service_cases.read")).toBe(true);
    expect(next.has("service_cases.write")).toBe(false);
    expect(next.has("service_cases.manage")).toBe(false);
    expect(next.has("projects.manage")).toBe(true); // untouched
  });
  it("never removes or adds an approval key the owner set explicitly", () => {
    const start = new Set(["service_cases.approve"]);
    const full = applyLevelToPerms(start, mod("service_cases"), "full");
    expect(full.has("service_cases.approve")).toBe(true); // kept
    const none = applyLevelToPerms(start, mod("service_cases"), "none");
    expect(none.has("service_cases.approve")).toBe(true); // still kept
  });
});

describe("moduleLevel", () => {
  it("reads the common page level and reports mixed on divergence", () => {
    const sc = mod("service_cases");
    const all = { service_cases: "view", "service_cases.cases": "view", "service_cases.pnl": "view" } as Record<string, any>;
    expect(moduleLevel(sc, all, new Set())).toBe("view");
    const mixed = { ...all, "service_cases.cases": "full" } as Record<string, any>;
    expect(moduleLevel(sc, mixed, new Set())).toBe("mixed");
  });
  it("derives a page-less module's level from the permission set", () => {
    const mail = mod("mail");
    expect(moduleLevel(mail, {}, new Set())).toBe("none");
    expect(moduleLevel(mail, {}, new Set(["mail_center.read"]))).toBe("view");
    expect(moduleLevel(mail, {}, new Set(["mail_center.read", "mail_center.manage"]))).toBe("full");
  });
});

describe("applyLevelToPages keeps dormant pages frozen", () => {
  it("sets live pages, leaves dormant ones at their current level", () => {
    const start = { service_cases: "none", "service_cases.cases": "none", "service_cases.pnl": "full" } as Record<string, any>;
    const next = applyLevelToPages(start, mod("service_cases"), "edit");
    expect(next["service_cases"]).toBe("edit");
    expect(next["service_cases.cases"]).toBe("edit");
    expect(next["service_cases.pnl"]).toBe("full"); // dormant, untouched
  });
});

describe("pageRowsToSend", () => {
  it("emits one row per page and derives the scm umbrella as max of its areas", () => {
    const levels = {
      "scm.sales": "view",
      "scm.sales.orders": "view",
      "scm.warehouse": "full",
      "scm.warehouse.inventory": "full",
    } as Record<string, any>;
    const rows = pageRowsToSend(PAGES, levels);
    expect(rows.length).toBe(PAGES.length);
    const scm = rows.find((r) => r.pageKey === "scm");
    expect(scm?.level).toBe("full"); // max(view, full)
    // pages with no staged level default to none
    expect(rows.find((r) => r.pageKey === "sales")?.level).toBe("none");
  });
  it("derives scm = none when every area is none", () => {
    const rows = pageRowsToSend(PAGES, { "scm.sales": "none", "scm.warehouse": "none" } as Record<string, any>);
    expect(rows.find((r) => r.pageKey === "scm")?.level).toBe("none");
  });
});

describe("reconcileScmAccess", () => {
  it("adds scm.access when any SCM area is >= view, removes it when all none", () => {
    expect(reconcileScmAccess(new Set(), { "scm.sales": "view" }).has("scm.access")).toBe(true);
    expect(reconcileScmAccess(new Set(["scm.access"]), { "scm.sales": "none", "scm.warehouse": "none" }).has("scm.access")).toBe(false);
  });
  it("ignores non-scm page keys", () => {
    expect(reconcileScmAccess(new Set(), { projects: "full" }).has("scm.access")).toBe(false);
  });
});

describe("diff helpers", () => {
  it("permsDiffer detects any symmetric difference", () => {
    expect(permsDiffer(new Set(["a"]), new Set(["a"]))).toBe(false);
    expect(permsDiffer(new Set(["a"]), new Set(["a", "b"]))).toBe(true);
    expect(permsDiffer(new Set(["a"]), new Set(["b"]))).toBe(true);
  });
  it("pageLevelsDiffCount counts changed pages", () => {
    const base = { sales: "none", projects: "view" } as Record<string, any>;
    const staged = { sales: "full", projects: "view" } as Record<string, any>;
    expect(pageLevelsDiffCount(PAGES, staged, base)).toBe(1);
  });
  it("maxLevel / MATRIX_LEVELS ordering", () => {
    expect(maxLevel("view", "full")).toBe("full");
    expect(maxLevel("edit", "view")).toBe("edit");
    expect(MATRIX_LEVELS).toEqual(["none", "view", "edit", "full"]);
  });
});
