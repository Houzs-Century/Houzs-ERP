import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { scmAreaGuard } from "../src/scm/middleware/area-guard";

/* THE GUARD ITSELF, not the rule it consults.
   `salesJdAccess.test.ts` proves SALES_JD says "none" and salesJdDenial says
   deny. That is exactly what was ALREADY true for three days while the Delivery
   Returns URL kept returning real data — the value was right and the enforcement
   never ran (scmAreaGuard skipped page_access entirely for any caller without an
   explicit `scm*` row). Proving the rule and proving the door are two different
   claims, and this repo has now been burned once by shipping the first as the
   second. These drive the REAL middleware, mounted on the REAL path from
   scm/index.ts:245, and assert the HTTP status. */

/** Mirrors the live mount: scm.use("/delivery-returns/*", scmAreaGuard(...)). */
function appFor(user: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  app.use("/delivery-returns/*", scmAreaGuard("scm.sales.returns"));
  app.all("/delivery-returns/*", (c) => c.json({ reached: true }));
  // A control area the JD says nothing about, mounted the same way.
  app.use("/purchase-orders/*", scmAreaGuard("scm.procurement.po"));
  app.all("/purchase-orders/*", (c) => c.json({ reached: true }));
  return app;
}

const salesRep = {
  id: 2,
  permissions: ["scm.access"],
  permissions_set: new Set(["scm.access"]),
  position_name: "Sales Executive",
  department_name: "Sales Department",
  page_access: {},
  // THE POINT: no explicit scm* row. Before this change the guard's no-lockout
  // fallthrough handed exactly this caller the returns API.
  scm_l2_configured: false,
};

const salesDirector = {
  ...salesRep,
  id: 3,
  position_name: "Sales Director",
  // z1 measured the Director as L2-configured; his own export shows scm.* = none.
  scm_l2_configured: true,
  page_access: { "scm.sales.returns": "none" as const },
};

describe("Delivery Returns API — the door, not the rule", () => {
  test("a Sales rep gets 403 on the Delivery Returns API", async () => {
    const res = await appFor(salesRep).request("/delivery-returns/");
    expect(res.status).toBe(403);
  });

  test("a Sales DIRECTOR gets 403 too — owner: sales director 算sales", async () => {
    const res = await appFor(salesDirector).request("/delivery-returns/");
    expect(res.status).toBe(403);
  });

  test("the 403 body is a sentence a person can act on, not a code", async () => {
    const res = await appFor(salesRep).request("/delivery-returns/");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Office");
    expect(body.error).not.toContain("scm.sales");
  });

  test("WRITES are shut too — a rep cannot POST a return", async () => {
    const res = await appFor(salesRep).request("/delivery-returns/", { method: "POST" });
    expect(res.status).toBe(403);
  });

  /* The four ways this change could have done real harm. */

  test("the `*` wildcard still reaches Delivery Returns — he must not lock himself out", async () => {
    const owner = { ...salesRep, permissions: ["*"], permissions_set: new Set(["*"]) };
    const res = await appFor(owner).request("/delivery-returns/");
    expect(res.status).toBe(200);
  });

  test("OFFICE is unmoved — it still reaches Delivery Returns exactly as before", async () => {
    const office = {
      ...salesRep,
      position_name: "Operation Executive",
      department_name: "Operation Department",
    };
    const res = await appFor(office).request("/delivery-returns/");
    expect(res.status).toBe(200);
  });

  test("the SAME Sales rep is unmoved everywhere else — Purchase Orders still open", async () => {
    // The JD denies one key. A rep with no scm* row still rides the no-lockout
    // fallthrough on every other area, exactly as yesterday.
    const res = await appFor(salesRep).request("/purchase-orders/");
    expect(res.status).toBe(200);
  });

  test("the no-lockout fallthrough is otherwise INTACT — an unconfigured non-Sales user passes", async () => {
    const nobody = {
      ...salesRep,
      position_name: null,
      department_name: null,
      scm_l2_configured: false,
    };
    expect((await appFor(nobody).request("/delivery-returns/")).status).toBe(200);
    expect((await appFor(nobody).request("/purchase-orders/")).status).toBe(200);
  });

  test("the matrix half still enforces for an L2-configured non-Sales user", async () => {
    // Regression guard: inserting the JD deny above the fallthrough must not
    // have disturbed the ordinary per-area check underneath it.
    const opsNoPo = {
      ...salesRep,
      position_name: "Operation Executive",
      department_name: "Operation Department",
      scm_l2_configured: true,
      page_access: { "scm.procurement.po": "none" as const },
    };
    expect((await appFor(opsNoPo).request("/purchase-orders/")).status).toBe(403);
  });
});
