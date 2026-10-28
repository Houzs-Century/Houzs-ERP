#!/usr/bin/env node
// Every test suite on disk is collected by a vitest project — nothing runs nowhere.
//
// WHY THIS IS A SCRIPT GATE AND NOT A TEST. It was written as a test first, in
// tests/scaleRealSchemaContract.test.mjs, and proven useless there the same hour:
// narrow the walk in scripts/lib/classify-tests.mjs back to `.test.ts` and vitest
// answers "No test files found" for the guard itself. The guard was one of the
// files that stops being collected. It would have vanished together with the 17
// suites it exists to protect, and the run would have gone GREEN with 267 files
// instead of 284.
//
// A guard that dies with the thing it guards is not a guard. This runs as its own
// CI step, so no change to a vitest include list can silence it.
//
// WHAT IT PREVENTS. A suite that is on disk but claimed by no project does not
// fail — it does not run, and CI is green. That is the single worst shape a test
// can take, and the repo has now hit it twice:
//   · `node --test` suites contributed nothing to the merged coverage report, so
//     twelve tested modules read as untested (BUG-HISTORY #2180).
//   · classify-tests.mjs walked `.test.ts` only, so renaming those suites to
//     `.test.mjs` would have dropped all 17 on the floor. Caught here.
//
// THE DUPLICATED WALK IS DELIBERATE. This file does NOT reuse the classifier's
// walk. It has its own, with its own extension list, precisely so that narrowing
// the classifier's produces a MISMATCH rather than two views that agree because
// they are the same code. Sharing the walk would make this gate tautological.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTests } from "./lib/classify-tests.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Independent of the classifier's, on purpose — see the header. */
const SUITE = /\.test\.(ts|tsx|mjs|js)$/;
const ROOTS = ["tests", "src"];

/** Configs that must keep DERIVING their include list rather than hard-coding one. */
const CONFIGS = ["vitest.config.mts", "vitest.light.config.mts"];

async function* walk(dir, rel) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(full, relPath);
    else if (SUITE.test(entry.name)) yield relPath;
  }
}

const { workers, light, declared } = await classifyTests(backendRoot);
const claimed = new Set([...workers, ...light]);

const onDisk = [];
for (const root of ROOTS) {
  for await (const rel of walk(path.join(backendRoot, root), root)) onDisk.push(rel);
}

const dropped = onDisk.filter((p) => !claimed.has(p)).sort();

/* A config that stopped consulting the classifier would make every number above
   meaningless: the gate would compare the classifier's answer against disk while
   vitest ran something else entirely. Cheap to check, and it is the only way this
   gate can be true and irrelevant at the same time. */
const unwired = [];
for (const cfg of CONFIGS) {
  const src = await fs.readFile(path.join(backendRoot, cfg), "utf8").catch(() => "");
  if (!src.includes("classifyTests")) unwired.push(cfg);
}

let failed = false;

if (dropped.length) {
  failed = true;
  console.error(
    `\nTEST-PROJECT GATE: ${dropped.length} suite(s) exist on disk but NO vitest project collects them.\n` +
      "They do not run, and nothing goes red — CI would simply report fewer files.\n",
  );
  for (const p of dropped) console.error(`  ${p}`);
  console.error(
    "\nEither the walk in scripts/lib/classify-tests.mjs stopped matching their extension,\n" +
      "or they were renamed into a shape it does not recognise. Fix the walk, do not\n" +
      "delete the files.\n",
  );
}

if (unwired.length) {
  failed = true;
  console.error(
    `\nTEST-PROJECT GATE: ${unwired.join(", ")} no longer calls classifyTests().\n` +
      "Its include list is hard-coded, so this gate is measuring something vitest does\n" +
      "not use. Restore the derived include, or this check is theatre.\n",
  );
}

if (failed) process.exit(1);

console.log(
  `test projects OK — ${onDisk.length} suite(s) on disk, all collected ` +
    `(${light.length} light, ${workers.length} workers).`,
);
/* Overrides are printed, never silent. `// @vitest-project` beats the content
   scan, so an override is a standing claim that no content rule can judge that
   file; it should be rare enough to read in full on every run. */
if (declared.length) {
  console.log(`  ${declared.length} file(s) declare their project explicitly:`);
  for (const p of declared) console.log(`    ${p}`);
}
