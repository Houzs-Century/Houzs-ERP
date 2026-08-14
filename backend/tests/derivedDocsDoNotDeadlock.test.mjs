/* The two derived-doc checks must separate a DEAD GENERATOR from DRIFTED OUTPUT.

   Both mirror something every pull request is required to change:
   `bug-index.md` mirrors BUG-HISTORY.md, which the working agreement makes
   every code PR append to, and `codebase-map-facts.md` embeds LINE NUMBERS,
   which move on every backend merge. main-protection makes merges strictly
   serial, so the instant one PR merges the file is stale on every other open
   PR — through no act of their authors.

   Measured 2026-08-14: five PRs failed `audit:bug-index` simultaneously on
   "175 entries", were regenerated one by one, and were stale again after the
   next merge. That is a deadlock wearing a gate's clothes.

   What the gate is FOR is the other failure: docs/staging-bench-rot-coe.md
   records `audit:map` crashing unnoticed for three weeks. A generator that
   produces nothing must still fail, loudly, and these tests pin that it does.

   node:test, no dependencies — run by `npm run test:scale-contract`. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const read = (f) => fs.readFileSync(path.join(SCRIPTS, f), "utf8");

const GENERATORS = ["gen-bug-index.mjs", "gen-codebase-map.mjs"];

test("drift does not exit non-zero, and says so in the message", () => {
  for (const g of GENERATORS) {
    const src = read(g);
    assert.match(src, /--strict/, `${g}: drift must stay failable on demand via --strict`);
    assert.match(src, /NOT failing the run/, `${g}: the drift message must say it is not charging the author`);
  }
});

test("a generator that produced nothing still fails, with exit 2", () => {
  /* exit 2 is this repo's "refusing to answer" code — the same one the
     file-size gate uses for an empty scan. A check that reports success on an
     empty measurement is the failure it is supposed to catch. */
  assert.match(read("gen-bug-index.mjs"), /entries\.length === 0[\s\S]*?process\.exit\(2\)/,
    "gen-bug-index: zero parsed entries must exit 2");
  assert.match(read("gen-codebase-map.mjs"), /routeTotals\.modules \|\| !desktopRoutes\.length[\s\S]*?process\.exit\(2\)/,
    "gen-codebase-map: an empty scan must exit 2");
});

test("neither check exits 1 on drift alone", () => {
  /* The narrow property: inside the checkOnly branch, the only process.exit(1)
     left must be guarded by --strict. Read as source rather than executed,
     because executing them needs the whole repo and this must stay cheap. */
  for (const g of GENERATORS) {
    const src = read(g);
    const body = src.slice(src.indexOf("checkOnly"));
    for (const m of body.matchAll(/process\.exit\(1\)/g)) {
      const before = body.slice(Math.max(0, m.index - 400), m.index);
      assert.match(before, /--strict/, `${g}: an exit(1) in the check path that --strict does not guard`);
    }
  }
});
