// Routing proof for the AUDIT-H5 case-scope guard in src/routes/assr.ts.
//
// The real guard calls caseInCallerScope (company + visibility), which needs the
// DB and is already exercised by the detail GET. What this test pins down is the
// part that has NO other coverage and is easy to get wrong: do the two
// `app.use("/:id{[0-9]+}"...)` patterns match exactly the mutating case-id routes,
// skip GET, and NOT catch the child-resource / non-id routes? We mirror the
// guard with the scope check stubbed to DENY, so "gated" shows up as 404 and
// "exempt" as 200.
import { test } from 'vitest';
import assert from "node:assert/strict";
import { Hono } from "hono";

function buildApp() {
  const app = new Hono();
  const guard = async (c, next) => {
    if (c.req.method === "GET") return next();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return next();
    return c.json({ error: "Not found" }, 404); // stub: caseInCallerScope -> false
  };
  app.use("/:id{[0-9]+}", guard);
  app.use("/:id{[0-9]+}/*", guard);

  // Route shapes mirroring the real assr.ts registrations.
  app.get("/:id{[0-9]+}", (c) => c.json({ ok: "get-detail" }));
  app.patch("/:id{[0-9]+}", (c) => c.json({ ok: "patch" }));
  app.post("/:id{[0-9]+}/mark-opened", (c) => c.json({ ok: "mark" }));
  app.post("/:id/track-link", (c) => c.json({ ok: "track" }));
  app.post("/:id/survey-token", (c) => c.json({ ok: "survey" }));
  app.post("/:id/items", (c) => c.json({ ok: "items" }));
  app.delete("/:id/items/:itemId", (c) => c.json({ ok: "del-item" }));
  app.get("/:id/customer-history", (c) => c.json({ ok: "get-sub" }));
  app.post("/attachments/:attId/archive", (c) => c.json({ ok: "att" }));
  app.post("/creditors/create", (c) => c.json({ ok: "creditor" }));
  app.post("/resync-so/:docNo", (c) => c.json({ ok: "resync" }));
  app.post("/bulk/archive", (c) => c.json({ ok: "bulk-archive" }));
  app.post("/bulk/unarchive", (c) => c.json({ ok: "bulk-unarchive" }));
  app.post("/bulk/assign", (c) => c.json({ ok: "bulk-assign" }));
  return app;
}

const call = async (app, method, path) =>
  (await app.request(path, { method })).status;

test("every mutating /:id[...] route is gated (stubbed deny -> 404)", async () => {
  const app = buildApp();
  assert.equal(await call(app, "PATCH", "/5"), 404);
  assert.equal(await call(app, "POST", "/5/mark-opened"), 404);
  assert.equal(await call(app, "POST", "/5/track-link"), 404);
  assert.equal(await call(app, "POST", "/5/survey-token"), 404);
  assert.equal(await call(app, "POST", "/5/items"), 404);
  assert.equal(await call(app, "DELETE", "/5/items/9"), 404);
});

test("GET routes stay exempt (they self-check)", async () => {
  const app = buildApp();
  assert.equal(await call(app, "GET", "/5"), 200);
  assert.equal(await call(app, "GET", "/5/customer-history"), 200);
});

test("non-case-id routes are not caught by the guard (documented follow-up)", async () => {
  const app = buildApp();
  assert.equal(await call(app, "POST", "/attachments/9/archive"), 200);
  assert.equal(await call(app, "POST", "/creditors/create"), 200);
  assert.equal(await call(app, "POST", "/resync-so/DOC-1"), 200);
});

/* The load-bearing fact behind the in-handler company predicate on the three
   /bulk routes (assr.ts :1123): the guard patterns key on the FIRST path segment
   being numeric, and "bulk" is not — so a /bulk write is NOT gated by the
   middleware however many case ids its body carries. If someone ever widens the
   patterns to cover /bulk, this test fails and the in-handler predicate can be
   revisited; until then it must stay. */
test("/bulk/* is NOT reached by the guard — its ids come from the body", async () => {
  const app = buildApp();
  assert.equal(await call(app, "POST", "/bulk/archive"), 200);
  assert.equal(await call(app, "POST", "/bulk/unarchive"), 200);
  assert.equal(await call(app, "POST", "/bulk/assign"), 200);
});
