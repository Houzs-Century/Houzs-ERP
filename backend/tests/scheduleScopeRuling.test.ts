import { describe, expect, test } from "vitest";

/* PATCH /delivery-planning/:type/:id/schedule is DELIBERATELY UNSCOPED.
 *
 * Owner ruling 2026-07-22: scheduling is a ONE-PERSON function. A single
 * dispatcher assigns driver / lorry / trip for the whole operation. Narrowing
 * the handler with `resolveDeliveryScope` — which restricts a policy-restricted
 * caller to jobs assigned to them — would lock that dispatcher out of every job
 * they do not already own, i.e. out of the board. The area guard's `edit` level
 * on `scm.transportation.drivers` is the intended and complete gate.
 *
 * WHY A TEST AND NOT ONLY A COMMENT. The sibling handler
 * `PATCH /:type/:id/fields` DOES call resolveDeliveryScope, one screen up in the
 * same file. That asymmetry reads like an oversight — it has already been
 * written up once as a gap and queued as a fix. Adding the scope call would look
 * like a tidy consistency patch in review and would silently break dispatch in
 * production. A comment can be skimmed past; this fails red.
 *
 * WHY A SOURCE TEST. There is nothing to assert at runtime: the correct
 * behaviour is the ABSENCE of a call, and the handler is Supabase/Postgres
 * (`c.get('supabase')`), which this suite's environment does not bind. Pinning
 * the source is the honest way to catch the edit that matters.
 *
 * WHY import.meta.glob AND NOT readFileSync: this suite runs in workerd, where
 * fs throws "not yet implemented in Workers". `?raw` is expanded by Vite at
 * TRANSFORM time, in Node, so the file contents are baked into the bundle. Same
 * technique, and same reason, as tests/adminResetLink.test.ts and
 * tests/migrationNumbers.test.ts.
 */

const sources = import.meta.glob("../src/scm/routes/delivery-planning.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? "";

const SCHEDULE_REG = "deliveryPlanning.patch('/:type/:id/schedule'";
const FIELDS_REG = "deliveryPlanning.patch('/:type/:id/fields'";

/** Strip comments so the assertions read CODE, not prose. Load-bearing, not
 *  tidiness: the handler's own docblock explains WHY it does not call
 *  resolveDeliveryScope, and it names the function to do so. Without this the
 *  "no scope call" assertion would fail on the comment that documents the
 *  ruling — the exact phantom this file exists to avoid. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Slice one handler out: from its route registration to the next top-level
 *  `deliveryPlanning.<verb>(` (or EOF — `/schedule` is the last registration in
 *  the file, so its slice runs through the trip-wiring helpers below it, which
 *  is correct: a scope call smuggled into that path should fail this too).
 *  Slicing matters — asserting over the whole 2000-line file would let the
 *  `fields` handler's legitimate scope call mask a re-added one in `schedule`. */
function handlerSource(registration: string): string {
  const start = routeSource.indexOf(registration);
  expect(start, `${registration} not found — did the route move or get renamed?`)
    .toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\ndeliveryPlanning\.(get|post|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
}

describe("PATCH /delivery-planning/:type/:id/schedule — unscoped BY RULING", () => {
  test("the source loaded (a silent empty glob must not pass)", () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain(SCHEDULE_REG);
  });

  test("the schedule handler does NOT narrow the caller to their own jobs", () => {
    const body = handlerSource(SCHEDULE_REG);
    expect(body.length).toBeGreaterThan(500);
    expect(
      body,
      "resolveDeliveryScope appeared in the schedule handler. This is NOT a " +
        "consistency fix — owner ruling 2026-07-22 says scheduling is done by " +
        "ONE dispatcher for the whole operation, and scoping locks them out of " +
        "everyone else's jobs. See the docblock above the route and " +
        "docs/modules/delivery-tms.md. Revisit only if dispatch becomes " +
        "per-region or per-depot.",
    ).not.toContain("resolveDeliveryScope");
    expect(body).not.toContain("scopeMatchesAssignment");
  });

  test("the fields handler still DOES scope — the asymmetry is the point", () => {
    /* The other half of the ruling, and the proof that the slicer above can see
       a scope call when one is really there. Editing a job's own data is a
       per-owner act; assignment decides whose job it becomes. If this ever goes
       red, the ownership rule on the execution path was dropped — that one IS a
       regression. */
    const body = handlerSource(FIELDS_REG);
    expect(body).toContain("resolveDeliveryScope");
    expect(body).toContain("scopeMatchesAssignment");
  });
});
