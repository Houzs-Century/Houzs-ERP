import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { scmAreaGuard } from "../src/scm/middleware/area-guard";

/* THE DOOR ON DELIVERY ORDERS + SALES INVOICES, not the map that describes it.
   SALES_JD has said `scm.sales.delivery: "view"` / `scm.sales.invoices: "view"`
   since 2026-07-17, and salesJdAccess.ts's own header admitted the cap was
   "still inert for a non-L2 rep". It was: the area-guard skips page_access
   entirely for any caller without an explicit `scm*` row, so a Sales-DEPARTMENT
   user with no position_id could POST a Delivery Order and a Sales Invoice while
   the written "view" sat unread in their map. Same shape as the Delivery Returns
   incident, one rule over.

   These drive the REAL middleware on the REAL mounts from scm/index.ts:237+248
   (both carry readInheritsFrom: "scm.sales.orders") and assert HTTP status. */

/** Mirrors the live mounts, options included. */
function appFor(user: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  app.use(
    "/delivery-orders-mfg/*",
    scmAreaGuard("scm.sales.delivery", { readInheritsFrom: "scm.sales.orders" }),
  );
  app.all("/delivery-orders-mfg/*", (c) => c.json({ reached: true }));
  app.use(
    "/sales-invoices/*",
    scmAreaGuard("scm.sales.invoices", { readInheritsFrom: "scm.sales.orders" }),
  );
  app.all("/sales-invoices/*", (c) => c.json({ reached: true }));
  // Sales OWNS the SO — the control that must NOT move.
  app.use("/mfg-sales-orders/*", scmAreaGuard("scm.sales.orders"));
  app.all("/mfg-sales-orders/*", (c) => c.json({ reached: true }));
  return app;
}

/* THE HOLE, EXACTLY. A user in a Sales department with no position_id hydrates
   from the legacy role matrix (auth.ts positionless branch), whose scm* keys
   backfill owner-only — so scm_l2_configured is FALSE and the `view` cap that
   applySalesJdOverride wrote into page_access was never read. */
const positionlessSalesRep = {
  id: 2,
  permissions: ["scm.access"],
  permissions_set: new Set(["scm.access"]),
  position_name: null,
  department_name: "Sales Department",
  page_access: { "scm.sales.delivery": "view" as const, "scm.sales.invoices": "view" as const },
  scm_l2_configured: false,
};

/** A POSITIONED rep — resolved through positionPolicy (scm.sales row → L2). */
const salesExecutive = {
  ...positionlessSalesRep,
  id: 3,
  position_name: "Sales Executive",
  scm_l2_configured: true,
  page_access: {
    "scm.sales.orders": "edit" as const,
    "scm.sales.delivery": "view" as const,
    "scm.sales.invoices": "view" as const,
  },
};

/** Owner 2026-07-18: "DO SI 只能看 salesdirector" — the Director is capped too. */
const salesDirector = {
  ...salesExecutive,
  id: 4,
  position_name: "Sales Director",
};

const CREATE = { method: "POST" };

describe("Delivery Orders — Sales may look, not operate", () => {
  test("a POSITIONLESS Sales-department user cannot create a DO (the hole)", async () => {
    const res = await appFor(positionlessSalesRep).request("/delivery-orders-mfg/", CREATE);
    expect(res.status).toBe(403);
  });

  test("a Sales Executive cannot create a DO", async () => {
    expect(
      (await appFor(salesExecutive).request("/delivery-orders-mfg/", CREATE)).status,
    ).toBe(403);
  });

  test("a Sales DIRECTOR cannot create a DO — owner: DO SI 只能看", async () => {
    expect(
      (await appFor(salesDirector).request("/delivery-orders-mfg/", CREATE)).status,
    ).toBe(403);
  });

  test("every write verb is shut, not just POST", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await appFor(positionlessSalesRep).request("/delivery-orders-mfg/x", { method });
      expect(res.status, method).toBe(403);
    }
  });

  test("the 403 says what to do, and does not leak a permission key", async () => {
    const res = await appFor(salesExecutive).request("/delivery-orders-mfg/", CREATE);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Office");
    expect(body.error).not.toContain("scm.sales");
  });
});

describe("Sales Invoices — same rule", () => {
  test("a POSITIONLESS Sales-department user cannot create an invoice", async () => {
    expect(
      (await appFor(positionlessSalesRep).request("/sales-invoices/", CREATE)).status,
    ).toBe(403);
  });

  test("a Sales Executive cannot create an invoice", async () => {
    expect((await appFor(salesExecutive).request("/sales-invoices/", CREATE)).status).toBe(403);
  });

  test("the convert-onward routes are shut too (/from-sos, /from-dos)", async () => {
    expect(
      (await appFor(salesExecutive).request("/delivery-orders-mfg/from-sos", CREATE)).status,
    ).toBe(403);
    expect(
      (await appFor(salesExecutive).request("/sales-invoices/from-dos", CREATE)).status,
    ).toBe(403);
  });
});

/* THE FOUR WAYS THIS COULD HAVE DONE REAL HARM. */
describe("what must NOT have moved", () => {
  test("Sales keeps READ on DO and SI — view + Print PDF are the job", async () => {
    for (const u of [positionlessSalesRep, salesExecutive, salesDirector]) {
      expect((await appFor(u).request("/delivery-orders-mfg/")).status).toBe(200);
      expect((await appFor(u).request("/sales-invoices/")).status).toBe(200);
    }
  });

  test("the readInheritsFrom hatch still works — a rep with ONLY scm.sales.orders reads DO/SI", async () => {
    const ordersOnly = {
      ...salesExecutive,
      page_access: { "scm.sales.orders": "edit" as const },
    };
    expect((await appFor(ordersOnly).request("/delivery-orders-mfg/")).status).toBe(200);
    expect((await appFor(ordersOnly).request("/sales-invoices/")).status).toBe(200);
  });

  test("Sales still OWNS the Sales Order — creating and editing an SO is untouched", async () => {
    expect(
      (await appFor(salesExecutive).request("/mfg-sales-orders/", CREATE)).status,
    ).toBe(200);
    expect(
      (await appFor(positionlessSalesRep).request("/mfg-sales-orders/", CREATE)).status,
    ).toBe(200);
  });

  test("the `*` wildcard still creates DOs and invoices — no self-lockout", async () => {
    const owner = {
      ...salesExecutive,
      permissions: ["*"],
      permissions_set: new Set(["*"]),
    };
    expect((await appFor(owner).request("/delivery-orders-mfg/", CREATE)).status).toBe(200);
    expect((await appFor(owner).request("/sales-invoices/", CREATE)).status).toBe(200);
  });

  test("OFFICE is unmoved — it still creates DOs and invoices", async () => {
    const office = {
      ...positionlessSalesRep,
      position_name: "Operation Executive",
      department_name: "Operation Department",
    };
    expect((await appFor(office).request("/delivery-orders-mfg/", CREATE)).status).toBe(200);
    expect((await appFor(office).request("/sales-invoices/", CREATE)).status).toBe(200);
  });

  test("the no-lockout fallthrough is otherwise INTACT — an unidentifiable caller passes", async () => {
    const nobody = {
      ...positionlessSalesRep,
      department_name: null,
      position_name: null,
    };
    expect((await appFor(nobody).request("/delivery-orders-mfg/", CREATE)).status).toBe(200);
  });
});
