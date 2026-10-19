import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { canViewItPages, IT_PAGES_WILDCARD_PASSES } from "./itAccess";
import { requireItPages } from "../middleware/auth";

describe("IT pages gate (DEV-35)", () => {
  it("is open to Owner: the wildcard passes", () => {
    expect(IT_PAGES_WILDCARD_PASSES).toBe(true);
  });

  it("admits it.view holders and the wildcard, nobody else", () => {
    expect(canViewItPages(["it.view"])).toBe(true);
    expect(canViewItPages(new Set(["it.view", "settings.manage"]))).toBe(true);
    expect(canViewItPages(["*"])).toBe(true);
    expect(canViewItPages(new Set(["*"]))).toBe(true);
    expect(canViewItPages(["settings.manage", "logs.read"])).toBe(false);
    expect(canViewItPages([])).toBe(false);
  });

  it("the middleware answers 200 for the wildcard and it.view, 403 for neither", async () => {
    const appWith = (perms: string[]) => {
      const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
      app.use("*", async (c, next) => { c.set("user", { id: 1, permissions: perms }); await next(); });
      app.use("*", requireItPages());
      app.get("/x", (c) => c.text("ok"));
      return app;
    };
    expect((await appWith(["*"]).request("/x")).status).toBe(200);
    expect((await appWith(["settings.manage"]).request("/x")).status).toBe(403);
    expect((await appWith(["it.view"]).request("/x")).status).toBe(200);
  });
});
