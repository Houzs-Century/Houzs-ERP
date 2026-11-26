import assert from "node:assert/strict";
import test from "node:test";
import { buildSteps, lintApps } from "./agent-check.mjs";

test("lint runs only for changed apps that have a lint script", () => {
  const changed = ["frontend/src/a.tsx", "frontend/src/b.tsx", "scripts/x.mjs", "e2e/t.spec.ts", "backend/src/c.ts"];
  assert.deepEqual(lintApps(changed, (app) => ["frontend", "backend"].includes(app)), ["backend", "frontend"]);
  assert.deepEqual(lintApps(["scripts/eslint/houzs-plugin.mjs"], () => true), ["backend", "frontend"]);
});

test("full run is the four checks then lint per app; --fast drops lint", () => {
  const names = (s) => s.map((x) => x.name);
  const base = ["layout", "new markdown", "docs size", "file size"];
  assert.deepEqual(names(buildSteps({ fast: false, apps: ["backend"] })), [...base, "lint backend"]);
  assert.deepEqual(names(buildSteps({ fast: true, apps: ["backend"] })), base);
  const lint = buildSteps({ fast: false, apps: ["frontend"] }).at(-1);
  assert.deepEqual([lint.cmd, lint.args, lint.shell], ["npm", ["--prefix", "frontend", "run", "lint"], true]);
  assert.equal(buildSteps({ fast: true, apps: [] })[0].cmd, process.execPath);
});
