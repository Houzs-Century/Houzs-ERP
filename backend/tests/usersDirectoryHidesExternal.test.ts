import { describe, expect, test } from "vitest";

/* GET /api/users hides external / outsourced logins from the member directory by
 * default (owner 2026-11-28, 「不要出现在 team member」): a 3PL driver who uploads
 * POD needs an "Outsource Transporter" login, but that account must not clutter
 * the Team Member list. An admin surfaces them with ?includeExternal=1 (to reset
 * a password or disable the account).
 *
 * WHY A SOURCE TEST, for the reason salesDirectorInviteRole.test.ts /
 * adminResetLink.test.ts give: this handler is Drizzle/Postgres and the suite
 * binds no Postgres, so a route test 500s before the WHERE runs. The invariant is
 * pinned against the handler's source, with comments stripped so an explanatory
 * comment cannot satisfy it.
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

const LIST = 'app.get("/"';

describe("the source is actually readable (guards against a silent empty glob)", () => {
  test("users.ts loaded and carries the list handler", () => {
    expect(usersRoute.length).toBeGreaterThan(10_000);
    expect(usersRoute).toContain(LIST);
  });
});

describe("GET /api/users hides external (outsource) logins by default", () => {
  test("the handler reads ?includeExternal and defaults to excluding", () => {
    const body = handlerSource(LIST);
    expect(body).toMatch(/includeExternal\s*=\s*c\.req\.query\("includeExternal"\)\s*===\s*"1"/);
    expect(body).toMatch(/if\s*\(\s*!includeExternal\s*\)/);
  });

  test("the exclusion filters the outsource position by BOTH name and slug", () => {
    // Comments are stripped, so the predicate itself must carry 'outsource' on
    // both columns — not merely an explanatory comment.
    const body = handlerSource(LIST);
    expect(body).toMatch(/NOT\s*\(/);
    expect(body).toMatch(/positions\.slug[\s\S]{0,80}outsource/);
    expect(body).toMatch(/positions\.name[\s\S]{0,80}outsource/);
  });

  test("the exclusion is a WHERE condition pushed BEFORE the query is built", () => {
    const body = handlerSource(LIST);
    const pushAt = body.search(/if\s*\(\s*!includeExternal\s*\)\s*\{\s*conds\.push/);
    const builtAt = body.search(/const built = db/);
    expect(pushAt, "the includeExternal guard must push a cond").toBeGreaterThan(-1);
    expect(builtAt, "the built query must exist").toBeGreaterThan(-1);
    expect(pushAt, "the exclusion must be added before the query is assembled").toBeLessThan(builtAt);
  });
});
