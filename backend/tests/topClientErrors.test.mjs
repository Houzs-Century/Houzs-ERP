/**
 * npx vitest run --config vitest.light.config.mts tests/topClientErrors.test.mjs
 *
 * The output of check-top-client-errors.mjs lands in a PUBLIC Actions log, so
 * the scrubbing is the part that must never regress.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyKind,
  scrubText,
  normalizeRoute,
  topFrame,
  groupTopErrors,
} from "../scripts/lib/top-client-errors.mjs";

test("classifyKind reads the reporter's bracketed labels", () => {
  assert.equal(classifyKind("[slow 2s+] GET /api/projects"), "slow");
  assert.equal(classifyKind("[timeout] POST /api/x"), "timeout");
  assert.equal(classifyKind("[api 502] GET /api/x"), "api-5xx");
  assert.equal(classifyKind("[rbac 403] GET /api/x"), "rbac-403");
  assert.equal(classifyKind("TypeError: x is undefined"), "js");
  assert.equal(classifyKind(""), "js");
});

test("scrubText removes personal data but keeps code vocabulary", () => {
  assert.equal(
    scrubText("TypeError: Cannot read properties of undefined (reading 'name')"),
    "TypeError: Cannot read properties of undefined (reading 'name')",
  );
  const s = scrubText(
    "Error: Customer \"Tan Ah Kow\" (ali@example.com, 012-345 6789) not found 张三 https://erp.example.com/assets/a.js?token=abc",
  );
  assert.ok(!s.includes("Tan"), s);
  assert.ok(!s.includes("ali@"), s);
  assert.ok(!s.includes("345"), s);
  assert.ok(!s.includes("6789"), s);
  assert.ok(!s.includes("张"), s);
  assert.ok(!s.includes("token"), s);
  assert.ok(!s.includes("example.com"), s);
  assert.ok(s.includes("/assets/a.js"), s);
  assert.ok(scrubText("x".repeat(500)).length <= 203);
});

test("normalizeRoute collapses ids and document numbers", () => {
  assert.equal(normalizeRoute("/projects/1435/edit"), "/projects/:id/edit");
  assert.equal(normalizeRoute("/scm/so/HC-SO-12345?tab=x"), "/scm/so/:id");
  assert.equal(normalizeRoute(""), "(none)");
});

test("topFrame skips the message line", () => {
  const st = "TypeError: boom\n    at render (https://erp.example.com/assets/index-abc.js:1:2345)";
  assert.equal(topFrame(st), "at render (/assets/index-abc.js:1:<n>)");
  assert.equal(topFrame(null), "");
});

test("groupTopErrors merges builds and pages, counts users without listing them", () => {
  const rows = [
    { dedup_hash: "a1", message: "TypeError: x", route: "/p/1", build_id: "b1", n: 5, first_seen: "2026-11-01T00:00:00Z", last_seen: "2026-11-02T00:00:00Z", users: [7, 8], stack: null },
    { dedup_hash: "a2", message: "TypeError: x", route: "/p/2", build_id: "b2", n: "3", first_seen: "2026-10-30T00:00:00Z", last_seen: "2026-11-05T00:00:00Z", users: [8, 9], stack: "TypeError: x\n at f (a.js:1:1)" },
    { dedup_hash: "c1", message: "[slow 2s+] GET /api/x", route: "/home", build_id: "b2", n: 4, first_seen: "2026-11-01T00:00:00Z", last_seen: "2026-11-01T00:00:00Z", users: [1], stack: null },
  ];
  const { top, totals } = groupTopErrors(rows, 15);
  assert.equal(top.length, 2);
  assert.deepEqual(
    { kind: top[0].kind, count: top[0].count, users: top[0].distinctUsers, builds: top[0].distinctBuilds, page: top[0].page },
    { kind: "js", count: 8, users: 3, builds: 2, page: "/p/:id" },
  );
  assert.equal(top[0].firstSeen, "2026-10-30T00:00:00Z");
  assert.equal(top[0].lastSeen, "2026-11-05T00:00:00Z");
  assert.equal(top[0].latestBuild, "b2");
  assert.equal(top[0].frame, "at f (a.js:1:1)");
  assert.equal(totals.occurrences, 12);
  assert.equal(totals.distinctUsers, 4);
  assert.deepEqual(totals.byKind, { js: 8, slow: 4 });
  assert.ok(!("users" in top[0]));
  assert.equal(groupTopErrors(rows, 1).top.length, 1);
});
