import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { scmAreaGuard } from "./area-guard";

/*
 * The driver run-sheet ("Last Mile Delivery (Driver)") READS the delivery board
 * and the job-progress feed, both mounted behind scmAreaGuard("scm.transportation
 * .drivers"). The Driver role is scm_l2_configured (it has explicit scm* rows) and
 * carries scm.transportation.last_mile=view but scm.transportation.drivers=none —
 * so before the readInheritsFrom hatch, an L2 driver 403'd on GET / and the page
 * showed "Couldn't load delivery planning". These pin the fix: a Last Mile viewer
 * READS the board; WRITES still require edit on the native area.
 */

type FakeUser = {
  permissions?: string[];
  scm_l2_configured?: boolean;
  page_access?: Record<string, string>;
};

const DRIVER_AREA = "scm.transportation.drivers";
const LAST_MILE = "scm.transportation.last_mile";

function request(user: FakeUser, method: "GET" | "POST") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  app.use("*", scmAreaGuard(DRIVER_AREA, { readInheritsFrom: LAST_MILE }));
  app.all("/x", (c) => c.json({ ok: true }));
  return app.request("/x", { method });
}

describe("scmAreaGuard — readInheritsFrom lets a Last Mile viewer read the board", () => {
  const driver: FakeUser = {
    permissions: ["scm.access"],
    scm_l2_configured: true,
    page_access: { [LAST_MILE]: "view", [DRIVER_AREA]: "none" },
  };

  it("GET: a driver (last_mile=view, drivers=none) is admitted via the inherit", async () => {
    expect((await request(driver, "GET")).status).toBe(200);
  });

  it("POST: a write never inherits — the driver still needs edit on the native area", async () => {
    expect((await request(driver, "POST")).status).toBe(403);
  });

  it("GET: an L2 caller with NEITHER grant is still 403", async () => {
    const stranger: FakeUser = {
      permissions: ["scm.access"],
      scm_l2_configured: true,
      page_access: { [LAST_MILE]: "none", [DRIVER_AREA]: "none" },
    };
    expect((await request(stranger, "GET")).status).toBe(403);
  });

  it("GET: native drivers=view is admitted without the inherit (unchanged)", async () => {
    const dispatcher: FakeUser = {
      permissions: ["scm.access"],
      scm_l2_configured: true,
      page_access: { [DRIVER_AREA]: "view" },
    };
    expect((await request(dispatcher, "GET")).status).toBe(200);
  });

  it("GET: a non-L2 caller still falls through the no-lockout path", async () => {
    const legacy: FakeUser = { permissions: ["scm.access"], scm_l2_configured: false };
    expect((await request(legacy, "GET")).status).toBe(200);
  });
});
