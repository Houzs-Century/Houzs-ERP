import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { supabaseAuth } from "../src/scm/middleware/auth";

/* The SCM auth bridge translates the Houzs session user into the shape the
   ported 2990 routes read: it stashes the REAL caller on `houzsUser` and then
   REPLACES `user` with the pinned scm.staff system uuid.

   That translation is one-way, so running it twice on one request destroys it —
   the second pass reads the pinned uuid as if it were the Houzs caller, and
   `Number("00000000-0000-4000-8000-000000000001")` is NaN. houzsUser then
   carries no usable id and no permissions, which is silent: nothing throws, the
   request still 200s, and every downstream visibility check simply fails closed.

   That is not hypothetical. On 2026-08-18 a second router
   (mfg-sales-orders-list-enrichment) was mounted at the SAME `/mfg-sales-orders`
   prefix as the main SO router, and both declare `use('*', supabaseAuth)`. Hono
   ran the first mount's middleware, matched no handler, fell through to the
   second, and ran the bridge again. canViewAllSales went false for everyone —
   the owner's `*` wildcard included — and resolveSalesScopeIds fail-closed to
   the match-nothing staff uuid, so the Sales Orders list served ZERO rows to
   every account in both companies until it was found.

   These tests pin the invariant that made that possible: the bridge must be
   idempotent, because "no prefix is ever double-mounted" is not something a
   route file can promise. */

type Ctx = { user?: { id?: unknown }; houzsUser?: { id?: number; permissions?: string[] } };

const HOUZS_CALLER = {
  id: 142,
  email: "someone@example.my",
  name: "Someone",
  position_name: "Logistic Executive",
  department_name: "Operation Office",
  permissions: ["scm.so.view_all"],
  permissions_set: new Set(["scm.so.view_all"]),
};

const SCM_SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";

/** Run the bridge `passes` times in one request, as a double mount does. */
async function runBridge(passes: number): Promise<Ctx> {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", HOUZS_CALLER); // what the global /api/* auth leaves behind
    await next();
  });
  for (let i = 0; i < passes; i++) app.use("*", supabaseAuth);

  let seen: Ctx = {};
  app.get("/probe", (c) => {
    seen = { user: c.get("user"), houzsUser: c.get("houzsUser") };
    return c.json({ ok: true });
  });

  // env only has to carry what getSupabaseService reads.
  await app.request("/probe", {}, { SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "test-key" });
  return seen;
}

describe("scm auth bridge — houzsUser survives a double mount", () => {
  test("one pass translates the caller", async () => {
    const { user, houzsUser } = await runBridge(1);
    expect(user?.id).toBe(SCM_SYSTEM_STAFF_ID);
    expect(houzsUser?.id).toBe(142);
    expect(houzsUser?.permissions).toContain("scm.so.view_all");
  });

  test("two passes leave the SAME result — not a NaN id", async () => {
    const { user, houzsUser } = await runBridge(2);
    expect(user?.id).toBe(SCM_SYSTEM_STAFF_ID);
    // The regression: houzsUser.id was Number(SCM_SYSTEM_STAFF_ID) === NaN.
    expect(houzsUser?.id).toBe(142);
    expect(Number.isFinite(houzsUser?.id)).toBe(true);
    // …and the permissions the visibility checks gate on were gone with it.
    expect(houzsUser?.permissions).toContain("scm.so.view_all");
  });

  test("three passes are still the same — idempotent, not merely two-safe", async () => {
    const { houzsUser } = await runBridge(3);
    expect(houzsUser?.id).toBe(142);
  });
});
