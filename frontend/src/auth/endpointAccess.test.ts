/* endpointAccess mirrors two backend gates so a side read is not made when it
   could only 403 (production, 7 days: 2,632 "[rbac 403]" reports). Pinned
   against the backend rules they copy: scmAreaReadable in
   backend/src/scm/middleware/area-guard.ts and requirePermissionOrSalesDirector
   ("users.read") on GET /api/users. */
import { describe, expect, test } from "vitest";
import type { AccessLevel, AuthUser } from "../types";
import { canListUsers, scmAreaReadable, type EndpointAccessAuth } from "./endpointAccess";

function auth(perms: string[], user: Partial<AuthUser> | null): EndpointAccessAuth {
  const set = new Set(perms);
  return {
    user: user as AuthUser | null,
    can: (p) => set.has("*") || set.has(p),
    pageAccess: (k) => (set.has("*") ? "full" : ((user?.page_access?.[k] ?? "none") as AccessLevel)),
  };
}

const AREA = "scm.transportation.drivers";

describe("scmAreaReadable", () => {
  test("wildcard reads every area", () => {
    expect(scmAreaReadable(auth(["*"], { id: 1 }), AREA)).toBe(true);
  });

  test("no SCM umbrella at all: the /api/scm gate refuses before the area", () => {
    expect(scmAreaReadable(auth(["projects.write"], { id: 1, page_access: {} }), AREA)).toBe(false);
  });

  test("umbrella without an L2 configuration falls through, as the guard does", () => {
    expect(scmAreaReadable(auth(["scm.access"], { id: 1, scm_l2_configured: false }), AREA)).toBe(true);
  });

  test("L2-configured: needs view on the area itself", () => {
    const pa = { "scm.sales.orders": "view", [AREA]: "none" } as AuthUser["page_access"];
    const u = { id: 1, scm_l2_configured: true, page_access: pa };
    expect(scmAreaReadable(auth(["scm.access"], u), AREA)).toBe(false);
    expect(scmAreaReadable(auth(["scm.access"], u), "scm.sales.orders")).toBe(true);
  });

  test("signed out reads nothing", () => {
    expect(scmAreaReadable(auth(["*"], null), AREA)).toBe(false);
  });
});

describe("canListUsers", () => {
  test("users.read or wildcard", () => {
    expect(canListUsers(auth(["users.read"], { id: 1 }))).toBe(true);
    expect(canListUsers(auth(["*"], { id: 1 }))).toBe(true);
  });

  test("a Sales Director by capability, without users.read", () => {
    const director = { id: 1, capabilities: { "org.salesDirector": true } } as unknown as Partial<AuthUser>;
    expect(canListUsers(auth([], director))).toBe(true);
  });

  test("anyone else is not asked", () => {
    expect(canListUsers(auth(["projects.write"], { id: 1, capabilities: {} } as unknown as Partial<AuthUser>))).toBe(false);
    expect(canListUsers(auth(["users.read"], null))).toBe(false);
  });
});
