#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-vocabulary.mjs — ONE guard for every concept in the registry.

   It replaces the shape that was hand-built three times. `soProcessingDateOneName`
   walks backend/scripts for one retired column; `transferVocabulary.corpus` does
   its own thing for another; a fourth concept needed a fourth author to remember.
   This walks the tree once and asks the registry what is retired, so registering
   a concept is the whole cost of guarding it.

   ALLOWED, and these are not loopholes but the reason the guard is trustworthy:
     - COMMENTS. `so-processing-date.mjs` quotes the owner naming the retired
       column verbatim, and that sentence is worth more than the tidiness of
       deleting it. Comments are stripped before matching.
     - MIGRATIONS. A migration records the rename it performed.
     - The declaration file itself, which has to spell the retired name to
       export it.

   A GUARD THAT MATCHED NOTHING MUST NOT REPORT A PASS — this repo has three
   separate incidents of exactly that. So it SELF-TESTS at startup: it plants a
   retired spelling in a synthetic source and asserts the matcher fires, and it
   asserts the same spelling inside a comment does NOT. If either check fails it
   exits 2 without reporting a verdict at all.

   RE-RUN: read-only, no database, no network. Same answer every time on the
   same tree.
   --------------------------------------------------------------------------- */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VOCABULARY, findRetired, stripComments } from "./lib/vocabulary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  path.join(here, "..", "src"),
  path.join(here, "..", "..", "frontend", "src"),
  path.join(here, "..", "scripts"),
];
const REPO = path.join(here, "..", "..");
const EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);

/* --- self-test, before any verdict ---------------------------------------- */
{
  const retired = VOCABULARY.flatMap((e) => e.retired);
  if (retired.length === 0) {
    console.error("REFUSING: the registry lists no retired spelling at all — this guard would pass over anything.");
    process.exit(2);
  }
  const term = retired[0];
  const inCode = findRetired(`const x = ${term};`, "backend/src/probe.ts");
  if (inCode.length === 0) {
    console.error(`REFUSING: the matcher did not fire on a planted "${term}" — it is dead, and a dead matcher reports a clean run.`);
    process.exit(2);
  }
  const inComment = findRetired(`// mentions ${term} in prose\nconst x = 1;`, "backend/src/probe.ts");
  if (inComment.length !== 0) {
    console.error(`REFUSING: the matcher fired inside a COMMENT for "${term}" — it would report the history as a defect.`);
    process.exit(2);
  }
  if (stripComments("/* a */ b").includes("a")) {
    console.error("REFUSING: stripComments does not strip.");
    process.exit(2);
  }
}

const walk = (dir, out = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
};

const files = ROOTS.flatMap((r) => walk(r));
if (files.length === 0) {
  console.error("REFUSING: walked the tree and found no source files — the roots have moved.");
  process.exit(2);
}

const findings = [];
for (const abs of files) {
  const rel = path.relative(REPO, abs).replace(/\\/g, "/");
  const hits = findRetired(fs.readFileSync(abs, "utf8"), rel);
  for (const h of hits) findings.push({ rel, ...h });
}

console.log(`vocabulary check — ${VOCABULARY.length} concept(s), ${files.length} source file(s) scanned`);
if (findings.length === 0) {
  console.log("every retired spelling appears only where it is allowed: comments, migrations, and its own declaration.");
  process.exit(0);
}
for (const f of findings) {
  console.log(`  ${f.rel}:${f.line}  "${f.term}" is retired — ${f.concept} is spelled "${f.canonical}"`);
}
console.error(`\n${findings.length} retired spelling(s) in CODE. See docs/generated/GLOSSARY.md.`);
process.exit(1);
