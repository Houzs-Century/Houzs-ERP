// Tests for the route-capability drift comparison (scripts/lib/route-matrix-diff.mjs).
//
// RUN IT WITH (from backend/):
//   node --test tests/routeMatrixDrift.node.mjs
// It is wired into `npm run test:scale-contract`, which is `pretest`, so it runs
// on every CI backend job.
//
// NO DEPENDENCIES: node:test / node:assert only. `npm install` in a worktree
// destroys the main checkout's node_modules, so a check that needs one is a
// check nobody runs.
//
// The gate this covers exists for ONE reason — a route's GATE changing must be
// noticed — and it was made quieter, so the half of this file that matters most
// is the half proving it still fails on every authorization change.
import assert from "node:assert/strict";
import { test } from 'vitest';

import { diffMatrices, formatDiff, readMatrix, parseCsv } from "../scripts/lib/route-matrix-diff.mjs";

const HEADERS =
  "method,path,auth_boundary,company_boundary,mount_gate,router_gate,direct_gate,handler_guard,mutation,review_state,source";

// Same quoting rule the generator uses, so the fixtures below are real CSV.
const field = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

const row = ({
  method = "GET",
  path = "/api/projects",
  auth = "AUTHENTICATED_MIDDLEWARE",
  company = "COMPANY_CONTEXT",
  mount = "auth",
  router = "",
  direct = "",
  handler = "",
  mutation = "NO",
  state = "DECLARED_GATE",
  source = "backend/src/routes/projects.ts",
} = {}) =>
  [method, path, auth, company, mount, router, direct, handler, mutation, state, source]
    .map(field)
    .join(",");

const csv = (...rows) => [HEADERS, ...rows, ""].join("\n");

// ---------------------------------------------------------------------------
// The noise this change is meant to remove.

test("a pure line shift is not drift — there are no line numbers to shift", () => {
  // The committed artifact carries the FILE only, so a comment block added above
  // a route (the 2026-07-21 case, hit twice in one day) produces an identical
  // artifact and this comparison never sees it.
  const before = csv(row(), row({ method: "POST", mutation: "YES" }));
  const after = csv(row(), row({ method: "POST", mutation: "YES" }));
  assert.equal(diffMatrices(before, after).drifted, false);
});

test("row ORDER is not drift — a clean git text-merge may interleave rows", () => {
  // This is the mechanism that lands a stale matrix on main without any CI run
  // ever seeing that tree, and then jams deploy.yml + deploy-staging.yml.
  const a = row({ path: "/api/a" });
  const b = row({ path: "/api/b" });
  const c = row({ path: "/api/c" });
  assert.equal(diffMatrices(csv(a, b, c), csv(c, a, b)).drifted, false);
});

test("CRLF vs LF is not drift", () => {
  const lf = csv(row());
  assert.equal(diffMatrices(lf.replace(/\n/g, "\r\n"), lf).drifted, false);
});

test("a trailing-newline difference is not drift", () => {
  assert.equal(diffMatrices(csv(row()).trimEnd(), csv(row())).drifted, false);
});

// ---------------------------------------------------------------------------
// The security the gate exists for. None of this may be relaxed.

test("a gate being REMOVED fails, and is reported as an authorization change", () => {
  const before = csv(row({ direct: 'requirePermission("projects.edit")' }));
  const after = csv(row({ direct: "" }));
  const diff = diffMatrices(before, after);
  assert.equal(diff.drifted, true);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.securityChanges.length, 1);
  assert.equal(diff.securityChanges[0].kind, "GATE_CHANGED");
  const report = formatDiff(diff);
  assert.match(report, /AUTHORIZATION GATES CHANGED/);
  assert.match(report, /direct_gate: "requirePermission\("projects\.edit"\)" -> ""/);
});

test("a gate being SWAPPED for a weaker one fails and prints both sides", () => {
  const before = csv(row({ direct: 'requirePermission("*")' }));
  const after = csv(row({ direct: 'requirePermission("projects.read")' }));
  const diff = diffMatrices(before, after);
  assert.equal(diff.drifted, true);
  assert.match(formatDiff(diff), /"requirePermission\("\*"\)" -> "requirePermission\("projects\.read"\)"/);
});

test("the auth boundary dropping to NO_STATIC_AUTH_GATE fails", () => {
  const diff = diffMatrices(
    csv(row({ auth: "AUTHENTICATED_MIDDLEWARE" })),
    csv(row({ auth: "NO_STATIC_AUTH_GATE" }))
  );
  assert.equal(diff.drifted, true);
  assert.equal(diff.securityChanges[0].kind, "GATE_CHANGED");
  assert.match(formatDiff(diff), /auth_boundary: "AUTHENTICATED_MIDDLEWARE" -> "NO_STATIC_AUTH_GATE"/);
});

test("the company boundary being lost fails", () => {
  const diff = diffMatrices(
    csv(row({ company: "COMPANY_CONTEXT" })),
    csv(row({ company: "NO_GLOBAL_COMPANY_CONTEXT" }))
  );
  assert.equal(diff.drifted, true);
  assert.equal(diff.securityChanges.length, 1);
});

test("every security column is compared, not just the obvious ones", () => {
  const columns = {
    auth: "X",
    company: "X",
    mount: "X",
    router: "X",
    direct: "X",
    handler: "X",
    state: "X",
  };
  for (const [key, value] of Object.entries(columns)) {
    const diff = diffMatrices(csv(row()), csv(row({ [key]: value })));
    assert.equal(diff.drifted, true, `${key} must be compared`);
    assert.equal(diff.securityChanges.length, 1, `${key} must count as a security change`);
  }
});

test("a mutation flag flip fails (it is not in SECURITY_COLUMNS but it is still drift)", () => {
  const diff = diffMatrices(csv(row({ mutation: "NO" })), csv(row({ mutation: "YES" })));
  assert.equal(diff.drifted, true);
  assert.match(formatDiff(diff), /Rows changed, no gate involved/);
});

test("a NEW route fails and is listed with its auth boundary", () => {
  const diff = diffMatrices(
    csv(row()),
    csv(row(), row({ method: "POST", path: "/api/pos/orders", mutation: "YES", state: "MUTATION_INHERITED_ONLY" }))
  );
  assert.equal(diff.drifted, true);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.securityChanges[0].kind, "ADDED");
  assert.match(formatDiff(diff), /\+ POST \/api\/pos\/orders/);
});

test("a route DISAPPEARING fails — a silently deleted route is a surface change", () => {
  const diff = diffMatrices(csv(row(), row({ path: "/api/gone" })), csv(row()));
  assert.equal(diff.drifted, true);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.securityChanges[0].kind, "REMOVED");
  assert.match(formatDiff(diff), /- GET \/api\/gone/);
});

test("a route moving to a different FILE fails", () => {
  // The file is still part of the compared identity; only the line is gone.
  const diff = diffMatrices(
    csv(row({ source: "backend/src/routes/projects.ts" })),
    csv(row({ source: "backend/src/routes/pms.ts" }))
  );
  assert.equal(diff.drifted, true);
  assert.equal(diff.added.length + diff.removed.length, 2);
});

test("a duplicate registration appearing is caught — the compare is a MULTISET", () => {
  // Two identical rows are not the same as one. If this collapsed to a set, a
  // second unreviewed registration of the same path could hide behind the first.
  const diff = diffMatrices(csv(row()), csv(row(), row()));
  assert.equal(diff.drifted, true);
  assert.equal(diff.added.length, 1);
});

test("one of two identical duplicate registrations disappearing is caught", () => {
  const diff = diffMatrices(csv(row(), row()), csv(row()));
  assert.equal(diff.drifted, true);
  assert.equal(diff.removed.length, 1);
});

test("a column being added or removed from the artifact is reported as such", () => {
  const diff = diffMatrices("method,path\nGET,/api/projects\n", csv(row()));
  assert.equal(diff.drifted, true);
  assert.equal(diff.headersChanged, true);
  assert.match(formatDiff(diff), /COLUMNS changed/);
});

test("an empty committed matrix does not read as 'no drift'", () => {
  const diff = diffMatrices("", csv(row()));
  assert.equal(diff.drifted, true);
});

// ---------------------------------------------------------------------------
// The CSV reader, because the gate columns contain commas and quotes.

test("quoted fields containing commas and doubled quotes round-trip", () => {
  const text = [
    HEADERS,
    'GET,/api/x,AUTHENTICATED_MIDDLEWARE,COMPANY_CONTEXT,auth,,"requireAnyPermission(""a"", ""b"")",,NO,DECLARED_GATE,backend/src/routes/x.ts',
    "",
  ].join("\n");
  const { records } = readMatrix(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].direct_gate, 'requireAnyPermission("a", "b")');
  assert.equal(records[0].source, "backend/src/routes/x.ts");
});

test("a comma inside a quoted gate does not shift the columns after it", () => {
  // The failure this guards: a naive split(',') would read `source` out of the
  // middle of a gate expression and every row would look like drift.
  const withComma = csv(
    'GET,/api/x,AUTHENTICATED_MIDDLEWARE,COMPANY_CONTEXT,auth,,"requireAnyPermission(""a"", ""b"")",,NO,DECLARED_GATE,backend/src/routes/x.ts'
  );
  assert.equal(diffMatrices(withComma, withComma).drifted, false);
});

test("parseCsv keeps empty trailing fields", () => {
  const rows = parseCsv("a,b,c\n1,,\n");
  assert.deepEqual(rows[1], ["1", "", ""]);
});
