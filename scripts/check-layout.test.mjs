import assert from "node:assert/strict";
import test from "node:test";
import { crossImports, layoutViolations } from "./check-layout.mjs";

const allow = { root: ["frontend", "backend", "docs"], "frontend/src": ["pages"], "backend/src": ["scm"], _baseline: ["junk.xlsx"] };

test("known folders and baseline files pass", () => {
  assert.deepEqual(layoutViolations(["frontend/src/pages/A.tsx", "frontend/src/main.tsx", "backend/src/scm/x.ts", "docs/a.md", "junk.xlsx"], allow), []);
});

test("a new root entry or a new src folder fails", () => {
  assert.deepEqual(layoutViolations(["plan.md", "frontend/src/widgets/W.tsx", "backend/src/new/x.ts", "backend/src/new/y.ts"], allow), [
    "backend/src: new/",
    "frontend/src: widgets/",
    "repo root: plan.md",
  ]);
});

test("frontend importing backend fails, imports inside the app pass", () => {
  assert.deepEqual(crossImports("frontend/src/pages/A.tsx", `import x from '../../../backend/src/scm/x';\nimport y from '../lib/y';`), [
    "frontend/src/pages/A.tsx imports ../../../backend/src/scm/x",
  ]);
  assert.equal(crossImports("backend/src/scm/a.ts", `const m = await import("../../../frontend/src/p");`).length, 1);
  assert.equal(crossImports("backend/src/scm/a.ts", `import "../../../frontend/src/side-effect";`).length, 1);
  assert.deepEqual(crossImports("backend/src/scm/a.ts", `import p from '../../../scripts/lib/p.mjs';`), []);
});

test("test files may read the other app", () => {
  assert.deepEqual(crossImports("backend/src/scm/a.test.ts", `import s from '../../../frontend/src/p.tsx?raw';`), []);
});
