import { describe, expect, test } from "vitest";

/* POST /api/users/invite — a department-scoped Sales Director never chooses the
 * new member's ROLE. docs/bugs/0887.
 *
 * The scoped branch used to default the role only when the client sent none
 * (`if (!body.role_id)`). The desktop invite sends no role (or the baseline one)
 * for a Sales Director, but the phone's Member form carries a required Role
 * picker fed by GET /api/roles — which admits a Sales Director — so a Sales
 * Director could invite an account, their own second email included, straight
 * into Super Admin. PATCH /:id already deletes role_id for the same caller;
 * the invite was the half that did not, while routes/roles.ts told readers that
 * "a scoped invite/patch forces a baseline role server-side".
 *
 * WHY A SOURCE TEST, for the reason adminResetLink.test.ts gives: this handler
 * is Drizzle/Postgres and the suite binds no Postgres, so a route test 500s
 * before the scoped branch runs. The invariant is pinned against the handler's
 * source, with comments stripped so an explanatory comment cannot satisfy it.
 */

const sources = import.meta.glob("../src/routes/users.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const usersRoute = Object.values(sources)[0] ?? "";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** From a route registration to the next top-level `app.<verb>(` registration. */
function handlerSource(registration: string): string {
  const start = usersRoute.indexOf(registration);
  expect(start, `${registration} not found — did the route move?`).toBeGreaterThan(-1);
  const rest = usersRoute.slice(start + 1);
  const next = rest.search(/\napp\.(post|get|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
}

/** The `{ ... }` block that follows `marker`, by brace matching. */
function blockAfter(body: string, marker: RegExp): string {
  const m = marker.exec(body);
  expect(m, `${marker} not found in the handler`).not.toBeNull();
  const from = body.indexOf("{", m!.index);
  let depth = 0;
  for (let i = from; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) return body.slice(from, i + 1);
  }
  throw new Error(`unbalanced block after ${marker}`);
}

const INVITE = 'app.post("/invite"';
const PATCH = 'app.patch("/:id"';

describe("the source is actually readable (guards against a silent empty glob)", () => {
  test("users.ts loaded and carries both handlers", () => {
    expect(usersRoute.length).toBeGreaterThan(10_000);
    expect(usersRoute).toContain(INVITE);
    expect(usersRoute).toContain(PATCH);
  });

  test("the scoped invite block is the real one, not a stray match", () => {
    const block = blockAfter(handlerSource(INVITE), /if\s*\(\s*inviteScope\.scoped\s*\)/);
    expect(block).toContain("body.department_id = inviteScope.deptId");
    expect(block.length).toBeLessThan(handlerSource(INVITE).length / 2);
  });
});

describe("a scoped (Sales Director) invite always carries the baseline role", () => {
  test("the role is resolved server-side inside the scoped branch", () => {
    const block = blockAfter(handlerSource(INVITE), /if\s*\(\s*inviteScope\.scoped\s*\)/);
    expect(block).toMatch(/resolveDefaultRoleId\(db\)/);
    expect(block).toMatch(/body\.role_id\s*=\s*\w+\s*;/);
  });

  test("no condition on the client's role_id can skip that assignment", () => {
    const block = blockAfter(handlerSource(INVITE), /if\s*\(\s*inviteScope\.scoped\s*\)/);
    // The old shape was `if (!body.role_id) { … body.role_id = def; }`: any
    // branch that reads the client's role_id is a door back to the escalation.
    expect(block).not.toMatch(/if\s*\([^)]*role_id/);
    expect(block).not.toMatch(/role_id\s*(\?\?|\|\|)/);
  });

  test("the forced role is set before the role lookup, the user write and the invitation write", () => {
    const body = handlerSource(INVITE);
    const assigned = body.search(/body\.role_id\s*=\s*\w+\s*;/);
    expect(assigned).toBeGreaterThan(-1);
    for (const later of [
      /eq\(roles\.id,\s*body\.role_id\)/,
      /insert\(users\)/,
      /update\(users\)/,
      /insert\(invitations\)/,
    ]) {
      const at = body.search(later);
      expect(at, `${later} not found`).toBeGreaterThan(-1);
      expect(assigned, `role forced after ${later}`).toBeLessThan(at);
    }
  });
});

describe("the edit half of the same rule stays in place", () => {
  test("PATCH /:id still strips role_id for a scoped Sales Director", () => {
    const block = blockAfter(handlerSource(PATCH), /if\s*\(\s*dirScope\.scoped\s*\)/);
    expect(block).toMatch(/delete\s+body\.role_id\s*;/);
  });
});
