#!/usr/bin/env node
/* Rename a list of fabric codes everywhere they are stored, and file them under
   the series their new code spells.

   WHY A SCRIPT. The Fabric Converter shows the code as fixed text because it is
   not only a label: the same string is the price-tier join on every order
   line, the colour inside each stock bucket, an entry in a sofa Model's fabric
   pool and, as its series, the key of an item KPI rule. Nothing in the database
   ties those together, so lib/fabric-code-rename.mjs moves all of them in one
   transaction or none.

   THE LISTS are in data/fabric-code-renames.json, one per owner request, so
   what was renamed is in the tree and not only in a run log. BATCH names one.

   MODE=plan (default) reads and prints; it writes nothing.
   MODE=apply needs CONFIRM="RENAME <batch>". After the commit a second, fresh
   connection plans the same list again: it has to find the codes renamed,
   nothing left to rewrite, and every rewritten variants block still an object.
   SCAN=all also counts the old codes in every text and json column of the
   database, listed or not (minutes on production). Run it once before and once
   after: it is the check that the carrier list missed nothing.

   The run log is public, so this prints codes, names and counts: no row, no
   document number, and money only through the public-log guard.

   RE-RUN: inert once applied. A second run finds the codes renamed and plans no
   write; if an order was saved on an old code in between (an open POS cart), it
   moves that line and nothing else. */
import "./lib/public-log-guard.mjs";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  planFabricCodeRename, readRenameState, resolveRenameCarriers, applyFabricCodeRename, shapeOfRenamedLines,
  scanEveryColumn,
} from "./lib/fabric-code-rename.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const BATCH = (process.env.BATCH || "").trim();
const SCAN_ALL = (process.env.SCAN || "").toLowerCase() === "all";
const STAMP = process.env.NOTE_DATE || new Date().toISOString().slice(0, 10);

const GH = !!process.env.GITHUB_ACTIONS;
const say = (m) => console.log(m);
const note = (m) => console.log(GH ? `::notice::${m}` : m);
const bad = (m) => console.log(GH ? `::error::${m}` : `ERROR ${m}`);

const BOOK = JSON.parse(readFileSync(new URL("./data/fabric-code-renames.json", import.meta.url), "utf8"));
const batch = BOOK[BATCH];
if (!batch) {
  bad(`set BATCH to one of: ${Object.keys(BOOK).join(", ")}`);
  process.exit(2);
}
const CONFIRM_PHRASE = `RENAME ${BATCH}`;
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const COMPANY = Number(batch.companyId);
const PAIRS = batch.pairs;

const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;
const rows = (list) => { for (const c of list) say(`    ${String(c.n).padStart(6)}  ${c.table}.${c.col}`); };

/** Read the database and plan the list against it. */
async function planOn(client) {
  const { usable, skipped } = await resolveRenameCarriers(client);
  const state = await readRenameState(client, COMPANY, PAIRS, usable);
  // The owner's rule for this kind of list: the code becomes what its
  // description already leads with, so a pair that disagrees is a typo here.
  const plan = planFabricCodeRename({ companyId: COMPANY, pairs: PAIRS, descriptionLeadsWithNewCode: true, stamp: STAMP, state });
  return { plan, state, carriers: usable, skipped };
}

function printPlan(plan, state, skipped) {
  const total = PAIRS.length;
  say(`\nCODES: ${plan.masters === "pending" ? `${plan.trackingMoves.length} of ${total} to rename`
    : plan.masters === "done" ? `all ${total} already renamed` : plan.masters}`);
  for (const m of plan.trackingMoves) say(`  ${m.from.padEnd(10)} -> ${m.to.padEnd(10)} ${m.description}`);

  if (plan.target) {
    say(`\nSELLING LIBRARY`);
    const c = plan.target.create;
    say(c
      ? `  series ${plan.target.id}: new (tier ${c.tier}, sofa ${c.sofaTier ?? "-"}, bedframe ${c.bedframeTier ?? "-"}; tier and surcharge copied from ${c.templateId})`
      : `  series ${plan.target.id}: exists`);
    if (plan.colourMoves.length) say(`  colours moved under ${plan.target.id}: ${plan.colourMoves.length}`);
    if (plan.supersede.length) say(`  series switched off and kept: ${plan.supersede.map((s) => s.id).join(", ")}`);
  }

  if (plan.kpi) {
    say(`\nITEM KPI`);
    say(`  ${plan.kpi.deleteIds.length + 1} fabric rule(s) at ${rm(plan.kpi.bonusSen)}${plan.kpi.active ? "" : " (off)"} become one rule on ${plan.kpi.ref}`);
    // A removed rule is recoverable from this list: every one of them pays
    // what the kept rule pays, or the plan would have refused.
    for (const r of state.kpiRules) {
      say(`    ${r.id === plan.kpi.keepId ? "keep  " : "remove"} ${r.id}  ${String(r.ref).padEnd(8)} ${rm(r.bonus_sen)}${r.active ? "" : " (off)"}  "${r.label}"`);
    }
  }

  if (plan.pools.length) {
    say(`\nMODEL FABRIC POOLS: ${plan.pools.length} model(s)`);
    for (const p of plan.pools) {
      const changed = p.before.filter((e) => !p.after.includes(e)).length;
      say(`  ${String(p.modelCode).padEnd(18)} ${changed} entr${changed === 1 ? "y" : "ies"} renamed, ${p.before.length} -> ${p.after.length} in the pool`);
    }
  }

  say(`\nROWS THAT NAME AN OLD CODE (company ${COMPANY})`);
  say(`  rewritten by this run:${plan.hits.rewritten.length ? "" : " none"}`);
  rows(plan.hits.rewritten);
  if (plan.hits.retained.length) { say(`  the old series rows, kept and switched off:`); rows(plan.hits.retained); }
  if (plan.hits.history.length) { say(`  history and caches, left as they read:`); rows(plan.hits.history); }
  if (plan.hits.unwritable.length) { say(`  NO WRITER:`); rows(plan.hits.unwritable); }
  for (const s of skipped) say(`  not in this database: ${s.table}.${s.col} (${s.why})`);

  if (plan.refusals.length) {
    say("");
    for (const r of plan.refusals) bad(`REFUSED: ${r}`);
  }
}

/** SCAN=all: the old codes in every column, not only the listed carriers. */
async function scanAll(client) {
  say(`\nEVERY TEXT AND JSON COLUMN (scm, public)`);
  const scan = await scanEveryColumn(client, COMPANY, PAIRS.map((p) => p.from));
  say(`  ${scan.tables} table(s), ${scan.columns} column(s); ${scan.hits.length} name an old code`);
  for (const h of scan.hits) {
    say(`    ${String(h.n).padStart(6)}  ${h.table}.${h.col}${h.scoped ? "" : "  (all companies)"}${h.listed ? "" : "  NOT IN THE CARRIER LIST"}`);
  }
  for (const f of scan.failed) bad(`could not be scanned: ${f}`);
  const unlisted = scan.hits.filter((h) => !h.listed);
  if (unlisted.length) bad(`${unlisted.length} column(s) name an old code and are not in the carrier list: decide for each whether it is live or history`);
  else note(`Full scan: every column that names an old code is in the carrier list.`);
  return unlisted.length + scan.failed.length;
}

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let applied = null;
  let target = null;
  try {
    const [co] = await sql`SELECT id, code, name FROM public.companies WHERE id = ${COMPANY}`;
    if (!co) throw new Error(`no company with id ${COMPANY}`);
    say(`${APPLY ? "APPLY" : "PLAN (writes nothing)"}   batch ${BATCH}   company ${co.id} ${co.code} (${co.name})`);
    say(batch.note);

    const { plan, state, carriers, skipped } = await planOn(sql);
    printPlan(plan, state, skipped);
    target = plan.target;
    if (SCAN_ALL && (await scanAll(sql)) > 0 && APPLY) {
      note(`The full scan found a column this script does not know. Nothing was written.`);
      process.exitCode = 1;
      return;
    }

    if (plan.refusals.length) {
      note(`${plan.refusals.length} refusal(s). Nothing was written.`);
      if (APPLY) process.exitCode = 1;
      return;
    }
    if (!plan.work) { note(`Nothing to do: the ${PAIRS.length} codes are renamed and no live row names an old one.`); return; }
    if (!APPLY) { note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`); return; }

    say(`\n=== WRITING (one transaction) ===`);
    applied = await sql.begin((tx) => applyFabricCodeRename(tx, { companyId: COMPANY, pairs: PAIRS, plan, carriers }));
    const m = applied.masters;
    say(`  Fabric Converter rows renamed ${m.trackings ?? 0}; colours moved ${m.colours ?? 0}; series created ${m.seriesCreated ?? "-"}; series switched off ${m.superseded}`);
    say(`  model pools ${applied.pools}; item KPI ${applied.kpi ? `kept 1, removed ${applied.kpi.removed}` : "untouched"}`);
    for (const s of applied.sweeps) say(`    ${String(s.n).padStart(6)}  ${s.arm} ${s.key}`);
    for (const s of applied.skippedArms) say(`  not in this database: ${s}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (!applied) return;

  // The session that wrote is the worst witness that the write landed.
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    say(`\n=== READ BACK ON A FRESH CONNECTION ===`);
    const { plan: after, state: now } = await planOn(check);
    if (after.masters !== "done") { fails++; bad(`the codes read as "${after.masters}", not renamed`); }
    for (const r of after.refusals) { fails++; bad(r); }
    for (const c of after.hits.rewritten) { fails++; bad(`${c.table}.${c.col} still names an old code on ${c.n} row(s)`); }
    if (after.kpi) { fails++; bad(`an item KPI rule is still on an old series`); }
    if (after.pools.length) { fails++; bad(`${after.pools.length} model pool(s) still list an old code`); }
    say(`  codes ${after.masters}; live rows still naming an old code: ${after.hits.rewritten.reduce((a, c) => a + c.n, 0)}`);

    const series = now.library.find((r) => r.id === target.id);
    const colours = now.seriesColours.filter((c) => c.fabric_id === target.id).length;
    say(`  series ${target.id}: ${series?.active ? "on" : "OFF"}, sofa ${series?.sofa_tier ?? "-"}, bedframe ${series?.bedframe_tier ?? "-"}, ${colours} colour(s)`);
    if (!series?.active || colours < PAIRS.length) { fails++; bad(`series ${target.id} is off or holds fewer than ${PAIRS.length} colours`); }
    const stillOn = now.library.filter((r) => after.sweepSeries.includes(r.id) && r.active !== false).map((r) => r.id);
    if (stillOn.length) { fails++; bad(`old series still switched on: ${stillOn.join(", ")}`); }
    for (const r of now.kpiRules) say(`  item KPI rule on ${r.ref}: ${rm(r.bonus_sen)}${r.active ? "" : " (off)"}`);

    for (const s of await shapeOfRenamedLines(check, COMPANY, PAIRS, target.id)) {
      say(`  ${s.arm}: ${s.lines} line(s) on the new codes, variants not an object ${s.not_object}, on another series ${s.other_series}`);
      if (s.not_object) { fails++; bad(`${s.arm}: ${s.not_object} variants block(s) are not an object`); }
      if (s.other_series) { fails++; bad(`${s.arm}: ${s.other_series} line(s) carry a new code under a series other than ${target.id}`); }
    }
  } finally {
    await check.end({ timeout: 5 });
  }
  if (fails) { bad(`${fails} problem(s) on the read-back. Run the plan again to see what is left.`); process.exitCode = 1; return; }
  note(`VERIFIED: ${PAIRS.length} fabric codes renamed; no live row names an old code.`);
}

main().catch((e) => { bad(e.message); process.exit(1); });
