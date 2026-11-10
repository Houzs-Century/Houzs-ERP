// The proof behind `npm run audit:public-log-money` and the runtime guard.
//
// The FIFO repair workflow printed unit costs into a PUBLIC Actions log on two
// dry-runs (2026-11-10, runs 42654976164 and 42655293840). The fixtures below
// are the shapes of the lines it printed, taken from the script source.

import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactMoney, redactRow, isMoneyKey, selfTest } from "../scripts/lib/public-log-redact.mjs";
import { scanSource, importsGuard } from "../scripts/lib/public-log-money-scan.mjs";

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the guard's own probes pass", () => {
  selfTest();
});

test("redacts every money shape the FIFO repair printed, keeps counts and codes", () => {
  const lines = [
    ["  BASIS per unit: 4500 sen = RM45.00  from GRN", "  BASIS per unit: [hidden] sen = RM[hidden]  from GRN"],
    ["    -> movement 12: 3 unit(s) x RM45.00 = RM135.00", "    -> movement 12: 3 unit(s) x RM[hidden] = RM[hidden]"],
    ["    movement 12: unit_cost_sen=4500 total_cost_sen=13500 consumed=3", "    movement 12: unit_cost_sen=[hidden] total_cost_sen=[hidden] consumed=3"],
    ["  lot 9  key=\"A\" batch=B1 @ RM12.00/u", "  lot 9  key=\"A\" batch=B1 @ RM[hidden]/u"],
    ["  RM booked onto previously-uncosted OUTs : RM1,234.56", "  RM booked onto previously-uncosted OUTs : RM[hidden]"],
    ["    MOVE consumption 4 (movement 5): 2 unit(s) 7 -> 8 @ 900 sen (was 800 sen)", "    MOVE consumption 4 (movement 5): 2 unit(s) 7 -> 8 @ [hidden] sen (was [hidden] sen)"],
    ["    STAMP movement 5: total_cost_sen=1800 (delta -200 sen, reported)", "    STAMP movement 5: total_cost_sen=[hidden] (delta [hidden] sen, reported)"],
    ["  units retro-costed (reconciled)         : 14", "  units retro-costed (reconciled)         : 14"],
    ["  MAKOTO-RC(S)-FVI  BRONZE  co=1 uncosted=3 drift=2", "  MAKOTO-RC(S)-FVI  BRONZE  co=1 uncosted=3 drift=2"],
  ];
  for (const [input, want] of lines) assert.equal(redactMoney(input), want);
});

test("money keys are told from count keys by word part", () => {
  for (const k of ["unit_cost_sen", "unitCostSen", "discount_sen", "price", "amount", "total_sen"]) assert.ok(isMoneyKey(k), k);
  for (const k of ["costless_count", "lots", "qty", "item_code", "cost_lots", "total"]) assert.ok(!isMoneyKey(k), k);
});

test("console.table rows lose money values, keep the rest", () => {
  assert.deepEqual(redactRow([{ item_code: "A", unit_cost_sen: 10, qty: 2 }]), [{ item_code: "A", unit_cost_sen: "[hidden]", qty: 2 }]);
});

test("the installed guard redacts in Actions and leaves local output alone", () => {
  const src = 'import "./scripts/lib/public-log-guard.mjs"; console.log("cost RM5.00 qty 3"); console.error("unit_cost_sen=900");';
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", src], { cwd: BACKEND, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const ci = run({ GITHUB_ACTIONS: "true" });
  assert.equal(ci.stdout, "cost RM[hidden] qty 3\n");
  assert.equal(ci.stderr, "unit_cost_sen=[hidden]\n");
  const local = run({});
  assert.equal(local.stdout, "cost RM5.00 qty 3\n");
});

test("the installed guard redacts the job summary, which the public run page renders", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-log-"));
  const summary = join(dir, "summary.md");
  const src = 'import "./scripts/lib/public-log-guard.mjs"; import { appendFileSync } from "node:fs"; appendFileSync(process.env.GITHUB_STEP_SUMMARY, "total RM 13,068.55\\n");';
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { cwd: BACKEND, env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(summary, "utf8"), "total RM [hidden]\n");
  rmSync(dir, { recursive: true, force: true });
});

test("scanner: a money formatter needs the guard; a raw unlabelled value fails outright", () => {
  const kinds = (src) => [...new Set(scanSource(src).map((f) => f.kind))].sort();
  assert.deepEqual(kinds("const rm = (s) => `RM${(Number(s) / 100).toFixed(2)}`;"), ["needs-guard"]);
  assert.deepEqual(kinds("const notice = (m) => console.log(m);\nnotice(`stamps to ${st.newTotalCostSen} (was x)`);"), ["unlabelled"]);
  assert.deepEqual(kinds("const notice = (m) => console.log(m);\nnotice(`STAMP: total_cost_sen=${st.newTotalCostSen}`);"), ["needs-guard"]);
  assert.deepEqual(kinds("console.log(`${a ? `x ${b.unit_price_sen}` : \"\"}`);"), ["unlabelled"]);
  assert.deepEqual(kinds("console.log(`rows ${rowsOf(\"PO line\", \"line_total_sen\").length}`);"), []);
  assert.deepEqual(kinds("const r = await pg`SELECT ${row.unit_cost_sen}`;"), []);
});

test("the FIFO repair script loads the guard before anything else", () => {
  const src = readFileSync(join(BACKEND, "scripts", "backfill-fifo-divergence.mjs"), "utf8");
  const first = src.match(/^\s*import\s[^\n]*$/m)[0];
  assert.ok(importsGuard(first), first);
});

test("the checker runs over a non-empty population and passes on the tree", () => {
  const ok = spawnSync(process.execPath, ["scripts/check-public-log-money.mjs"], { cwd: BACKEND, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /dispatchable scripts of \d+/);
});
