/* The owner's twelve fabric series must be ONE list, and every script that
   DERIVES over the fabric library must ask it.

   This fails on the tree as it stood on 2026-08-14: normalize-fabric-codes held
   its own copy and tidy-fabric-descriptions had no copy at all, so the
   production plan reported 249 of the owner's own rows (78 in the Fabric
   Converter, 171 in the selling library) as `code is not canonical (would be
   DE-01) — fix the CODE first`. Nothing was written — every one of them failed
   the canonicality guard and stopped there — but a report that files 249
   correct rows next to the real ones is how the real ones stop being read.

   node:test with no dependencies, run by `npm run test:scale-contract`: the
   backend vitest suite runs in workerd and cannot read the filesystem. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE_SERIES, isCatalogueSeries } from "../scripts/lib/catalogue-series.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const read = (p) => fs.readFileSync(path.join(SCRIPTS, p), "utf8");

/** The scripts that DERIVE a canonical code/description and would therefore
 *  overwrite the owner's hand-made spelling if they did not know about it. */
const DERIVERS = ["normalize-fabric-codes.mjs", "tidy-fabric-descriptions.mjs"];

/** The catalogue's own source, and the shared list itself. These two are the
 *  only files entitled to name all twelve. */
const SEED = "seed-owner-fabric-catalogue.mjs";

test("the twelve series the owner dictated are all present", () => {
  for (const s of ["ZL", "MODENZA", "BO315", "NX", "GD2502", "AM275", "CH141", "M2402", "ORION", "TR", "DE", "HR805"]) {
    assert.ok(CATALOGUE_SERIES.has(s), `${s} missing from the catalogue list`);
  }
  assert.equal(CATALOGUE_SERIES.size, 12);
});

test("membership is asked of the PARSED series, so DE01 and DE-01 answer the same", () => {
  assert.equal(isCatalogueSeries("DE"), true);
  assert.equal(isCatalogueSeries("de"), true);
  assert.equal(isCatalogueSeries(" DE "), true);
  assert.equal(isCatalogueSeries("PC"), false);
  assert.equal(isCatalogueSeries(null), false);
  assert.equal(isCatalogueSeries(undefined), false);
});

test("every deriver asks the shared list", () => {
  for (const f of DERIVERS) {
    const src = read(f);
    assert.match(src, /from "\.\/lib\/catalogue-series\.mjs"/, `${f} does not import the shared list`);
    assert.match(src, /isCatalogueSeries\(/, `${f} imports the list but never asks it`);
  }
});

test("a series the seed adds cannot be one the derivers would trample", () => {
  /* The seed builds its rows through the local helper N("<SERIES>", …). Any
     series it declares that the shared list does not hold is a series
     normalize-fabric-codes would happily re-derive, undoing the owner's own
     spelling on the next run. */
  const declared = new Set([...read(SEED).matchAll(/\bN\(\s*"([A-Z0-9 ]+)"/g)].map((m) => m[1]));
  assert.ok(declared.size >= 9, `parsed ${declared.size} series out of the seed — the helper shape changed, fix this test`);
  const missing = [...declared].filter((s) => !CATALOGUE_SERIES.has(s));
  assert.deepEqual(missing, [], `the seed declares these, and the shared list does not hold them: ${missing.join(", ")}`);
});

test("no other script holds a copy of the whole list", () => {
  /* Measured on 2026-08-14 rather than assumed: the only two files naming all
     twelve are the seed (the catalogue's source) and the shared list itself.
     The next highest is 7 of 12 — probe-write-persistence and the
     add/create-missing-sofa-fabrics pair, which name a handful of series as
     SAMPLES, not as the list. So "names all twelve" separates a copy from a
     mention with room on both sides. */
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "data") walk(p); continue; }
      if (!e.name.endsWith(".mjs")) continue;
      const rel = path.relative(SCRIPTS, p);
      if (rel === SEED || rel === path.join("lib", "catalogue-series.mjs")) continue;
      const src = fs.readFileSync(p, "utf8");
      const named = [...CATALOGUE_SERIES].filter((s) => new RegExp(`["']${s}["']`).test(src));
      if (named.length === CATALOGUE_SERIES.size) offenders.push(rel);
    }
  };
  walk(SCRIPTS);
  assert.deepEqual(offenders, [], `these hold their own copy instead of importing lib/catalogue-series.mjs: ${offenders.join(", ")}`);
});
