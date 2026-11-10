import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { scmAreaGuard, scmAreaReadable } from "../src/scm/middleware/area-guard";
import { requireScmAccess } from "../src/middleware/auth";

/* scmAreaReadable answers "could this person open that area?" for a caller
   OUTSIDE /api/scm (global search). It is only worth anything while it gives
   the SAME answer as the doors themselves, so every case below asks both: the
   real requireScmAccess umbrella + the real scmAreaGuard on a GET, and the
   predicate. A drift in either fails here. */

const AREAS = ["scm.finance.accounting", "scm.procurement.suppliers", "scm.sales.returns"] as const;

function door(user: unknown, area: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  app.use("/api/scm/*", requireScmAccess as never);
  app.use("/api/scm/x/*", scmAreaGuard(area));
  app.get("/api/scm/x/*", (c) => c.json({ reached: true }));
  return app;
}

const base = { id: 9, permissions: [] as string[], permissions_set: new Set<string>(), page_access: {}, scm_l2_configured: false };
const USERS: Record<string, Record<string, unknown>> = {
  owner: { ...base, permissions: ["*"], permissions_set: new Set(["*"]) },
  "scm.access, no L2 config": { ...base, permissions: ["scm.access"], permissions_set: new Set(["scm.access"]) },
  "no SCM at all": { ...base },
  "L2: finance view only": {
    ...base,
    scm_l2_configured: true,
    page_access: { "scm.finance.accounting": "view", "scm.procurement.suppliers": "none", "scm.sales.returns": "none" },
  },
  "L2: suppliers edit only": {
    ...base,
    scm_l2_configured: true,
    page_access: { "scm.procurement.suppliers": "edit" },
  },
  "Sales rep (JD denies returns)": {
    ...base,
    permissions: ["scm.access"],
    permissions_set: new Set(["scm.access"]),
    position_name: "Sales Executive",
    department_name: "Sales Department",
  },
};

describe("scmAreaReadable agrees with the real doors on a GET", () => {
  for (const [name, user] of Object.entries(USERS)) {
    for (const area of AREAS) {
      test(`${name} — ${area}`, async () => {
        const res = await door(user, area).request("/api/scm/x/list");
        expect(scmAreaReadable(user as never, area)).toBe(res.status === 200);
      });
    }
  }

  test("no user is never readable", () => {
    expect(scmAreaReadable(null, "scm.finance.accounting")).toBe(false);
  });

  test("the matrix is not vacuous: both answers occur", async () => {
    const answers = new Set<boolean>();
    for (const user of Object.values(USERS)) for (const area of AREAS) answers.add(scmAreaReadable(user as never, area));
    expect([...answers].sort()).toEqual([false, true]);
  });
});
