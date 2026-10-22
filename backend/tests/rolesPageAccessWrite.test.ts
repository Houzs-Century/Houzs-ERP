import { describe, expect, test } from "vitest";
import {
  isValidPositionLevel,
  isValidPageKey,
  isRetiredPageKey,
  RETIRED_PAGE_KEYS,
} from "../src/services/pageAccess";

/* PATCH /api/roles/:id/page-access — the RBAC rebuild's page-access write (PR2).
 *
 * WHY A SOURCE TEST (the reason salesDirectorInviteRole.test.ts gives): this
 * handler is Drizzle/Postgres and the suite binds no Postgres, so a live route
 * test 500s before the validation runs. The invariant is pinned against the
 * handler's source (comments stripped so an explanatory comment cannot satisfy
 * it) plus the pure predicates it leans on.
 *
 * WHY IT GATES A MERGE (MUST_GATE_MERGE): the write stores role_page_access rows
 * that decide who sees the GL, payment vouchers and stock. If the validation
 * loosened — admitting a retired key the resolver treats inertly, the looser
 * 5-level `partial`, or dropping the system-role / `*` protection — an admin's
 * save would silently fail to mean what it says (the owner's long-standing
 * "设了没用 / 设过被删" complaint), with the deploy perfectly healthy. That has to
 * stop a MERGE, not surface after it. */

const sources = import.meta.glob("../src/routes/roles.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const rolesRoute = Object.values(sources)[0] ?? "";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** From a route registration to the next top-level `app.<verb>(` registration. */
function handlerSource(registration: string): string {
  const start = rolesRoute.indexOf(registration);
  expect(start, `${registration} not found — did the route move?`).toBeGreaterThan(-1);
  const rest = rolesRoute.slice(start + 1);
  const next = rest.search(/\napp\.(post|get|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
}

describe("PATCH /api/roles/:id/page-access — write contract", () => {
  const h = handlerSource('app.patch("/:id/page-access"');

  test("validates every level with isValidPositionLevel (4-level; rejects legacy partial)", () => {
    expect(h).toContain("isValidPositionLevel");
    // The looser 5-level validator would admit `partial`, which the matrix never
    // writes — using it here would re-open the vocabulary drift.
    expect(h).not.toContain("isValidAccessLevel");
  });

  test("rejects unknown and retired page keys", () => {
    expect(h).toContain("isValidPageKey");
    expect(h).toContain("isRetiredPageKey");
  });

  test("protects system roles and the * wildcard", () => {
    expect(h).toContain("is_system");
    expect(h).toContain('includes("*")');
  });

  test("refuses an empty replace-set (an empty body reverts the role to the legacy fallback)", () => {
    expect(h).toMatch(/entries\.length\s*===\s*0|!Array\.isArray\(entries\)/);
  });

  test("busts every member session so the change lands on the next request", () => {
    expect(h).toContain("bustUserSessions");
  });
});

describe("the predicates the write route leans on", () => {
  test("isValidPositionLevel admits exactly none/view/edit/full", () => {
    for (const ok of ["none", "view", "edit", "full"]) expect(isValidPositionLevel(ok)).toBe(true);
    for (const bad of ["partial", "", "FULL", "manage", "x"]) expect(isValidPositionLevel(bad)).toBe(false);
  });

  test("every retired key fails isValidPageKey, so the route 400s it", () => {
    for (const k of RETIRED_PAGE_KEYS) {
      expect(isRetiredPageKey(k)).toBe(true);
      expect(isValidPageKey(k)).toBe(false);
    }
  });
});
