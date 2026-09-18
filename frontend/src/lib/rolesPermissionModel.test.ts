import { describe, it, expect } from "vitest";
import type { PermissionDef } from "../types";
import {
  buildModules,
  stemOf,
  isLockedRole,
  activeIds,
  setPerm,
  setPerms,
  cellState,
  moduleCounts,
  diffGrants,
  VERBS,
  type GrantMap,
} from "./rolesPermissionModel";

// A small catalogue that captures the three real shapes: a clean CRUD resource
// (Service Cases), a single-key resource (Activity Log), and a heterogeneous one
// (Projects) whose one-off grants don't fit a tidy verb grid.
const CATALOG: PermissionDef[] = [
  { key: "service_cases.read", resource: "Service Cases", verb: "read", label: "View service cases", description: "" },
  { key: "service_cases.create", resource: "Service Cases", verb: "create", label: "Log service cases", description: "" },
  { key: "service_cases.write", resource: "Service Cases", verb: "write", label: "Edit service cases", description: "" },
  { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "Manage service cases", description: "" },
  { key: "logs.read", resource: "Activity Log", verb: "read", label: "View activity log", description: "" },
  { key: "projects.read", resource: "Projects", verb: "read", label: "View projects", description: "" },
  { key: "projects.chat", resource: "Projects", verb: "write", label: "Post project chat", description: "" },
  { key: "projects.write", resource: "Projects", verb: "write", label: "Edit projects", description: "" },
  { key: "projects.approve", resource: "Projects", verb: "manage", label: "Approve gated steps", description: "" },
  { key: "projects.manage", resource: "Projects", verb: "manage", label: "Manage projects", description: "" },
];

describe("stemOf", () => {
  it("strips a trailing verb, leaves other keys intact", () => {
    expect(stemOf("service_cases.read", "read")).toBe("service_cases");
    expect(stemOf("projects.write", "write")).toBe("projects");
    expect(stemOf("projects.chat", "write")).toBe("projects.chat"); // doesn't end in the verb
    expect(stemOf("projects.approve", "manage")).toBe("projects.approve");
  });
});

describe("buildModules", () => {
  const mods = buildModules(CATALOG);

  it("makes one module per resource, in first-seen order", () => {
    expect(mods.map((m) => m.id)).toEqual(["Service Cases", "Activity Log", "Projects"]);
  });

  it("collapses a CRUD resource into one row with four verb cells", () => {
    const sc = mods.find((m) => m.id === "Service Cases")!;
    expect(sc.rows).toHaveLength(1);
    const row = sc.rows[0];
    expect(row.stem).toBe("service_cases");
    expect(row.label).toBe("Service Cases");
    expect(row.keyByVerb).toEqual({
      read: "service_cases.read",
      create: "service_cases.create",
      write: "service_cases.write",
      manage: "service_cases.manage",
    });
    expect(sc.keys).toHaveLength(4);
  });

  it("labels a single-key row from the catalogue label", () => {
    const log = mods.find((m) => m.id === "Activity Log")!;
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].label).toBe("View activity log");
    expect(log.rows[0].sub).toBe("logs.read");
    expect(log.rows[0].keyByVerb).toEqual({ read: "logs.read" });
  });

  it("spreads a heterogeneous resource into a core row plus one-off rows", () => {
    const pj = mods.find((m) => m.id === "Projects")!;
    expect(pj.rows.map((r) => r.stem)).toEqual(["projects", "projects.chat", "projects.approve"]);
    const core = pj.rows[0];
    expect(core.keyByVerb).toEqual({
      read: "projects.read",
      write: "projects.write",
      manage: "projects.manage",
    });
    expect(core.keyByVerb.create).toBeUndefined(); // renders N/A
    // An "approve"-style grant lands in the MANAGE column, as its own row.
    expect(pj.rows[2].keyByVerb.manage).toBe("projects.approve");
    expect(pj.rows[1].label).toBe("Post project chat");
  });

  it("ignores the wildcard key", () => {
    const withStar = buildModules([
      ...CATALOG,
      { key: "*", resource: "Everything", verb: "manage", label: "All", description: "" },
    ]);
    expect(withStar.some((m) => m.id === "Everything")).toBe(false);
  });
});

describe("isLockedRole", () => {
  it("locks system roles and wildcard holders, not plain custom roles", () => {
    expect(isLockedRole({ is_system: true, permissions: [] })).toBe(true);
    expect(isLockedRole({ is_system: false, permissions: ["*"] })).toBe(true);
    expect(isLockedRole({ is_system: false, permissions: ["projects.read"] })).toBe(false);
  });
});

describe("activeIds — system-role guard #1", () => {
  const locked = new Set([1]); // role 1 is a system role

  it("uses the single selection when fewer than two are checked", () => {
    expect(activeIds(5, [], locked)).toEqual([5]);
    expect(activeIds(5, [7], locked)).toEqual([5]); // one checkbox is not bulk
  });

  it("uses the checked set once two or more are checked", () => {
    expect(activeIds(5, [2, 3], locked)).toEqual([2, 3]);
  });

  it("filters system roles out of the write target", () => {
    expect(activeIds(1, [], locked)).toEqual([]); // selecting a system role alone -> no target
    expect(activeIds(9, [1, 2, 3], locked)).toEqual([2, 3]); // bulk drops the system role
  });
});

describe("setPerm / setPerms — guard #2 (skip locked) + immutability", () => {
  it("adds a key only to non-locked roles and does not mutate the input", () => {
    const grants: GrantMap = { 1: new Set(), 2: new Set() };
    const next = setPerm(grants, [1, 2], "projects.read", true, new Set([1]));
    expect([...next[2]]).toEqual(["projects.read"]);
    expect(next[1].size).toBe(0); // locked role untouched
    expect(grants[2].size).toBe(0); // original not mutated
  });

  it("removes a key when toggled off", () => {
    const grants: GrantMap = { 2: new Set(["a", "b"]) };
    const next = setPerm(grants, [2], "a", false, new Set());
    expect([...next[2]].sort()).toEqual(["b"]);
  });

  it("setPerms applies many keys at once, skipping locked roles", () => {
    const grants: GrantMap = { 1: new Set(), 2: new Set() };
    const next = setPerms(grants, [1, 2], ["a", "b"], true, new Set([1]));
    expect([...next[2]].sort()).toEqual(["a", "b"]);
    expect(next[1].size).toBe(0);
  });
});

describe("cellState", () => {
  const grants: GrantMap = { 2: new Set(["k"]), 3: new Set(["k"]), 4: new Set() };
  it("is na for a missing key or empty target", () => {
    expect(cellState(undefined, [2], grants)).toBe("na");
    expect(cellState("k", [], grants)).toBe("na");
  });
  it("is on when every active role has it", () => {
    expect(cellState("k", [2, 3], grants)).toBe("on");
  });
  it("is off when none have it", () => {
    expect(cellState("k", [4], grants)).toBe("off");
  });
  it("is partial when some have it", () => {
    expect(cellState("k", [2, 4], grants)).toBe("partial");
  });
});

describe("moduleCounts", () => {
  it("sums grants and totals across the active roles", () => {
    const mods = buildModules(CATALOG);
    const sc = mods.find((m) => m.id === "Service Cases")!; // 4 keys
    const grants: GrantMap = {
      2: new Set(["service_cases.read"]),
      3: new Set(["service_cases.read", "service_cases.write"]),
    };
    expect(moduleCounts(sc, [2, 3], grants)).toEqual({ on: 3, total: 8 });
  });
});

describe("diffGrants", () => {
  it("counts added and removed keys and names the changed roles only", () => {
    const baseline: GrantMap = { 2: new Set(["a"]), 3: new Set(["a"]) };
    const grants: GrantMap = { 2: new Set(["a", "b"]), 3: new Set(["a"]) };
    expect(diffGrants(grants, baseline)).toEqual({ total: 1, roleIds: [2] });
  });

  it("counts removals too", () => {
    const baseline: GrantMap = { 2: new Set(["a", "b"]) };
    const grants: GrantMap = { 2: new Set() };
    expect(diffGrants(grants, baseline)).toEqual({ total: 2, roleIds: [2] });
  });

  it("is clean when nothing changed", () => {
    const g: GrantMap = { 2: new Set(["a"]) };
    expect(diffGrants(g, { 2: new Set(["a"]) })).toEqual({ total: 0, roleIds: [] });
  });
});

describe("approve verb (added on main)", () => {
  it("is the fifth column and buckets an approve key into it", () => {
    expect(VERBS).toEqual(["read", "create", "write", "manage", "approve"]);
    const mods = buildModules([
      { key: "announcements.read", resource: "Announcements", verb: "read", label: "View", description: "" },
      { key: "announcements.approve", resource: "Announcements", verb: "approve", label: "Approve announcements", description: "" },
    ]);
    const ann = mods.find((m) => m.id === "Announcements")!;
    // Both keys share the "announcements" stem, so one row carries read + approve.
    expect(ann.rows).toHaveLength(1);
    expect(ann.rows[0].keyByVerb).toEqual({
      read: "announcements.read",
      approve: "announcements.approve",
    });
  });
});
