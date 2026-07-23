// Bundle-size budget gate.
//
// Runs after `vite build` (see ci.yml). Measures the production JS in
// dist/assets and fails CI when THIS CHANGE makes the bundle materially
// heavier, so a stray `import` of a heavy library into the always-loaded path —
// the thing that actually makes first paint slow — is caught in review instead
// of in production.
//
// HOW IT DECIDES (changed 2026-07-22 — read this before touching a number)
//
// Every metric is compared against a BASELINE measured on the merge base, built
// by the same toolchain in the same CI run (see the "bundle baseline" step in
// .github/workflows/ci.yml). The verdict is the DELTA. Absolute ceilings are
// kept, but demoted: a ceiling can only fail the PR that actually crosses it,
// and when main is already over, the report says so in those words and the PR
// passes. The rules, and the four false failures that forced this, are written
// out in scripts/lib/bundle-verdict.mjs — that file is the specification.
//
// Short version of why: on a `pull_request` event GitHub builds the MERGE with
// main, so every PR inherits main's bundle. An absolute ceiling therefore fails
// whichever PR happens to run after main spends the budget. On 2026-07-21 that
// was #873 — a DOCS-ONLY PR touching `docs/mockups/pdf/*` and zero source files
// — failing `total JS (gzip) 1770.1 KB / 1770.0 KB`, over by 0.1 KB it did not
// and could not have added.
//
// Usage:
//   node scripts/check-bundle-size.mjs                      # ceilings only
//   node scripts/check-bundle-size.mjs --json out.json      # measure, write, exit 0
//   node scripts/check-bundle-size.mjs --baseline base.json # delta vs merge base
//
// Run locally: `npm run build && node scripts/check-bundle-size.mjs`
//
// ---------------------------------------------------------------------------
// Measurement history (kept: the diff is the audit trail)
//
//   baseline 2026-06-13 (after route code-splitting):
//     initial JS gzip  ~84.6 KB  (index 30.9 + react-vendor 53.8)
//     total   JS gzip  ~370  KB
//     largest chunk    ~200  KB raw (Projects)
//
//   2026-06-25 (after the SCM 2990 cutover landed in full):
//     initial JS gzip ~115.5 KB  (index 38.3 + react-vendor 77.3)
//   react-vendor is pure framework — react + react-dom + react-router +
//   @tanstack/react-query — every byte of which is eager by necessity
//   (the QueryClientProvider/Router wrap the whole app). index is the app
//   shell + the route table: the cutover registered ~50 new lazy routes,
//   and while each PAGE is code-split, its lazy() declaration + <Route>
//   live in the always-loaded shell.
//
//   2026-06-30 (lucide tree-shake fix + accumulated drift):
//     initial JS gzip ~118.8 KB  (index 41.5 + react-vendor 77.3)
//     total   JS gzip ~1348 KB
//     largest chunk    ~430 KB raw (xlsx)
//   The lucide-react chunk dropped from ~777 KB raw → ~82 KB after replacing
//   `import * as Lucide` + `lucide-react/dynamicIconImports` in Categories.tsx
//   with named imports + a static ICON_MAP (Rollup can now tree-shake the rest
//   of the icon set out). That removed ~115 KB gzip from total JS.
//
//   2026-07-16 (route prefetch) — read this as a warning about the line above:
//     initial JS gzip ~130.0 KB  (main measured 129.7 on PR #625)
//   The 2026-06-30 bump left ~11 KB of headroom over the 118.8 measured that
//   day. It was GONE: main sat at 129.7 — 99.8% — and nobody bumped or recorded
//   a number on the way up, so the gate had quietly become a tripwire that the
//   next commit, any commit, was going to hit. This one did, at +0.3 KB.
//
//   2026-07-18 (measure what the browser fetches):
//     initial JS gzip ~155 KB, measured from dist/index.html
//   This gate had never counted `lucide` or `vendor`, both of which index.html
//   modulepreloads, so the real eager payload on that same commit was ~269 KB
//   gzip — roughly double what the gate reported PASS on. `vendor` was ~117 KB
//   of it and was almost entirely jspdf's dependency tree, eager only because
//   manualChunks co-located it with @remix-run/router; see vite.config.ts.
//   Fixing the chunking dropped the true figure to ~155 KB and the initial set
//   now comes from the emitted HTML, so this class of drift cannot recur
//   silently.
//
//   2026-07-19: total 1748.9 -> 1753.4 (Fulfillment Costing mobile screen);
//   ceiling 1750 -> 1770, then the same day 1770 -> 1800 after TWO unrelated
//   branches tripped the spent budget within hours of each other.
//
//   2026-07-20: main sat exactly at 1770 and a cosmetic page-titles PR was the
//   one that failed; the already-documented 1800 was finally applied.
//
//   2026-07-21: total on main reached ~1770.0 and docs-only PR #873 failed at
//   1770.1. Four false failures in eight days, four bumps, zero of them the
//   cause. The fifth bump is not the fix — the comparison is.
//
//   2026-07-23 (initial-bundle diet):
//     initial JS gzip ~143.3 KB  (index 58.0 + react-vendor 75.1 + lucide-initial 9.7)
//   Main sat AT the 165.0 ceiling and every entry-touching PR tripped the gate.
//   Three cuts, no behaviour change: (1) the unauthenticated screens code-split
//   behind auth/AuthGate.tsx — a signed-in session never fetches the login/
//   bootstrap/invite UI (~19 KB raw); (2) auth/salesAccess.ts imports
//   COSTING_DISPLAY_ENABLED from its concrete module instead of the
//   @2990s/shared barrel, which had been dragging sofa-build + mfg-pricing +
//   phone + friends (~24 KB raw) into the entry for one boolean; (3) lucide
//   split into lucide-initial ($initial-tagged shell icons, ~27 KB raw) +
//   lucide (route-only icons, now lazy) — the old single group was the union
//   of every icon ANY route uses (~52 KB raw), all eagerly preloaded. Total
//   JS 1753.5 -> 1767.8 (gzip-dictionary cost of the splits, all lazy bytes).

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KB, evaluateAll, formatResult, explainResult, VERDICT, REASON } from "./lib/bundle-verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const ASSETS = join(DIST, "assets");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const jsonOut = argValue("--json");
const baselinePath = argValue("--baseline");
const distArg = argValue("--dist");
const distDir = distArg ? distArg : DIST;
const assetsDir = join(distDir, "assets");

// Absolute ceilings. KB = 1000 bytes (matches Vite's build output, not 1024).
//
// These are no longer the primary verdict — GROWTH is (see below). A ceiling
// now answers one question only: "is THIS change the one that crosses a line we
// wrote down?". When the merge base is already past it, the run prints
// OVER-ON-MAIN and passes, because failing a PR for growth it did not cause is
// the defect this gate spent four bumps demonstrating.
const CEILINGS = {
  // Always-loaded path: every chunk dist/index.html fetches eagerly. This is
  // what blocks first paint regardless of route. 136 -> 165 on 2026-07-18 when
  // the metric started counting all four eagerly-fetched chunks instead of two
  // (the same build, measured honestly for the first time; the true figure on
  // the old commit was ~269 KB and removing jspdf's tree from the eager path
  // cut it to ~155). Keep tight: a real regression here is a first-paint cost.
  INITIAL_JS_GZIP: 165 * KB,
  // Everything the app can lazy-load (users only fetch the routes they visit).
  // A soft guard against unbounded total growth, not a first-paint cost. Left
  // at 1800 deliberately — main is at ~99% of it and RAISING IT AGAIN IS NOT
  // THE FIX. From 2026-07-22 the growth allowance below is what fails a PR, and
  // this number's remaining job is to keep printing OVER-ON-MAIN on every run
  // until someone makes a deliberate decision about the lazy tail on main.
  //
  // WHEN IT DOES GET DECIDED: check INITIAL_JS_GZIP first (if that is healthy,
  // the lazy tail is still lazy and growth here is users paying only for pages
  // they open), then look for a formerly-lazy module that has become eagerly
  // reachable — that is the failure mode this budget exists to catch, and the
  // vite.config manualChunks comment documents the last time it happened.
  TOTAL_JS_GZIP: 1800 * KB,
  // Any single chunk, raw. A route blowing past this should be split. Sized to
  // fit the heaviest vendored lib — xlsx (~430 KB raw), pulled out of the eager
  // `vendor` chunk and loaded only on export.
  MAX_CHUNK_RAW: 600 * KB,
};

// What ONE change is allowed to add, over the merge base. This is the gate now.
//
// Sized from what the failure modes actually look like, measured in this repo:
//   * a new lazy route page      +4 to +8 KB gzip on total, ~+0.1 KB on initial
//   * a shared hook + ~30 imports  +2.8 KB gzip on total  (perf/frontend-audit)
//   * a stray heavy library on the eager path
//                                 +16 KB (lucide) to +117 KB (jspdf tree) gzip
// So: initial +8 KB is roughly 80x a legitimate route registration and half the
// smallest real regression on record — a stray import cannot hide under it.
// Total +60 KB is ~8 new pages in one PR, or one vendored library, which is
// exactly the size of change that should have to say so out loud.
const GROWTH = {
  INITIAL_JS_GZIP: 8 * KB,
  TOTAL_JS_GZIP: 60 * KB,
  // Per-chunk raw growth. A chunk gaining 100 KB raw without crossing the
  // absolute ceiling is still a route getting out of hand.
  MAX_CHUNK_RAW: 100 * KB,
};

// The chunks that load on first paint no matter which route you hit.
//
// Read out of the built dist/index.html — the entry <script type="module"> plus
// every <link rel="modulepreload">. That IS the eager set by definition: it is
// the list the browser fetches before it knows what route it is on.
//
// This was a hardcoded ["index-", "react-vendor-"] prefix list, and the list
// silently stopped matching reality (see the 2026-07-18 entry above). Parsing
// the emitted HTML costs nothing and cannot drift — change the chunking and this
// follows automatically, which is exactly what the prefix list failed to do.
function readInitialChunks(dir) {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const names = new Set();
  // Both the entry script and the preload links point at /assets/<name>.js.
  for (const m of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) {
    names.add(m[1]);
  }
  return names;
}

// Chunk file names carry a content hash, so they are useless as a key across two
// builds. Strip the hash so `Projects-a1b2c3d4.js` on main and
// `Projects-99887766.js` on the PR are recognised as the same chunk.
function chunkKey(name) {
  return name.replace(/-[A-Za-z0-9_]{8,}\.js$/, ".js");
}

function measure(dir) {
  const assets = join(dir, "assets");
  let files;
  try {
    files = readdirSync(assets).filter((f) => f.endsWith(".js"));
  } catch {
    throw new Error(`no build found at ${assets} — run \`vite build\` first.`);
  }
  if (files.length === 0) throw new Error(`${assets} has no .js files — build looks empty.`);

  const chunks = files
    .map((name) => {
      const buf = readFileSync(join(assets, name));
      return {
        name,
        key: chunkKey(name),
        raw: statSync(join(assets, name)).size,
        gzip: gzipSync(buf).length,
      };
    })
    .sort((a, b) => b.raw - a.raw);

  let initialChunks;
  try {
    initialChunks = readInitialChunks(dir);
  } catch {
    throw new Error(`no index.html at ${dir} — run \`vite build\` first.`);
  }
  if (initialChunks.size === 0) {
    throw new Error(`${dir}/index.html references no /assets/*.js — cannot measure first paint.`);
  }

  for (const chunk of chunks) chunk.initial = initialChunks.has(chunk.name);

  return {
    initialGzip: chunks.filter((c) => c.initial).reduce((s, c) => s + c.gzip, 0),
    totalGzip: chunks.reduce((s, c) => s + c.gzip, 0),
    largestRaw: chunks[0].raw,
    largestName: chunks[0].name,
    chunks: chunks.map(({ name, key, raw, gzip, initial }) => ({ name, key, raw, gzip, initial })),
  };
}

const fmt = (n) => `${(n / KB).toFixed(1).padStart(7)} KB`;

let current;
try {
  current = measure(distDir);
} catch (err) {
  console.error(`[bundle-size] ${err.message}`);
  process.exit(1);
}

// --json: measure and write, nothing else. This is how the merge-base build
// hands its numbers to the run that judges the PR.
if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `[bundle-size] measured initial ${fmt(current.initialGzip)} total ${fmt(current.totalGzip)} ` +
      `largest ${fmt(current.largestRaw)} raw -> ${jsonOut}`
  );
  process.exit(0);
}

let baseline = null;
let baselineNote = "no merge-base baseline (ceilings enforced absolutely)";
if (baselinePath) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (typeof baseline.totalGzip !== "number") throw new Error("missing totalGzip");
    baselineNote = `merge base, from ${baselinePath}`;
  } catch (err) {
    baseline = null;
    baselineNote = `baseline at ${baselinePath} unusable (${err.message}) — ceilings enforced absolutely`;
  }
}

// The largest chunk on main may not be the largest chunk here. Compare like for
// like: the baseline for "largest chunk raw" is that same chunk on main when it
// exists, else main's largest.
function baselineLargestRaw() {
  if (!baseline?.chunks) return baseline?.largestRaw ?? null;
  const same = baseline.chunks.find((c) => c.key === chunkKey(current.largestName));
  return same ? same.raw : baseline.largestRaw;
}

console.log(`\nBundle size report (${assetsDir}/*.js)\n`);
console.log("  chunk                                    raw        gzip");
console.log("  " + "-".repeat(58));
for (const c of current.chunks) {
  console.log(`  ${c.name.padEnd(40)}${fmt(c.raw)}${fmt(c.gzip)}${c.initial ? " [initial]" : ""}`);
}
console.log("  " + "-".repeat(58));

const { results, failed } = evaluateAll([
  {
    label: "initial JS (gzip)",
    current: current.initialGzip,
    baseline: baseline ? baseline.initialGzip : null,
    ceiling: CEILINGS.INITIAL_JS_GZIP,
    growth: GROWTH.INITIAL_JS_GZIP,
  },
  {
    label: "total JS (gzip)",
    current: current.totalGzip,
    baseline: baseline ? baseline.totalGzip : null,
    ceiling: CEILINGS.TOTAL_JS_GZIP,
    growth: GROWTH.TOTAL_JS_GZIP,
  },
  {
    label: "largest chunk (raw)",
    current: current.largestRaw,
    baseline: baseline ? baselineLargestRaw() : null,
    ceiling: CEILINGS.MAX_CHUNK_RAW,
    growth: GROWTH.MAX_CHUNK_RAW,
  },
]);

console.log(`\nBudgets  (baseline: ${baselineNote})\n`);
for (const r of results) console.log(formatResult(r));
console.log(`\n  largest chunk is ${current.largestName}`);

const notes = results.filter((r) => r.reason !== REASON.OK);
if (notes.length > 0) {
  console.log("");
  for (const r of notes) console.log(explainResult(r));
}
console.log("");

if (failed) {
  const causes = results.filter((r) => r.verdict === VERDICT.FAIL).map((r) => r.label).join(", ");
  console.error(`[bundle-size] FAILED on: ${causes}. See the explanation above — it names whether\n` +
    `the growth came from this change or from the merge base.`);
  process.exit(1);
}
console.log("[bundle-size] within budget.\n");
