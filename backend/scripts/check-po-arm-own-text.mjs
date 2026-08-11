#!/usr/bin/env node
/* READ-ONLY: is the PURCHASE ORDER arm's variant data backed by each line's own
   AutoCount text? Section B of diag-so-po-variant-divergence.mjs asks this of
   the SO arm and answered CORROBORATED 2363 / CONTRADICTED 0. Nobody had ever
   asked it of the PO arm corpus-wide - it was covered only indirectly, through
   the GRN parents in section E - so whether that arm carries collision damage
   of its own was an open question rather than a measured one. This closes it.

   SELECTs only. No writes, no DDL, no transaction. Exit 0 for every legitimate
   answer; the OUTPUT is the answer (the check-soak-gate.mjs contract). A red job
   here would read as "the check broke", which is not what a finding is.

   The reasoning, the authority (description2, not linked_ac_dtlkey) and the
   segmentation are documented on lib/po-arm-own-text.mjs, which holds the
   classifier this and repair-collided-po-variants.mjs share.

   DATABASE_URL required. */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import {
  PO_LINE_SQL, buildCollidedPoKey, parseAcToErpCsv, classifyPoLine, tally,
  blockFor, norm2,
} from "./lib/po-arm-own-text.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const j = (v) => JSON.stringify(v);
const pad = (n, w) => String(n).padStart(w);

async function main() {
  log("=== PO arm vs its own AutoCount text (READ-ONLY) ===");

  const poExport = gz("ac-outstanding-po.json.gz");
  const soExport = gz("ac-outstanding-so.json.gz");
  const byDtl = new Map();
  for (const r of [...poExport, ...soExport]) byDtl.set(Number(r.DtlKey), r);
  const acToErp = parseAcToErpCsv(fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8"));
  const collided = buildCollidedPoKey(poExport, acToErp);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  log(`export rows: PO ${poExport.length}, SO ${soExport.length}; fabric library ${fcRows.length} colours`);

  /* ── the ceiling, computed from the export alone ────────────────────────────
     Before a single row is read, the export says how much damage is even
     POSSIBLE: a key can only mis-stamp a line if two of its rows parse
     differently. This bounds the DB answer and makes a zero result checkable
     rather than merely asserted. */
  const groups = new Map();
  for (const r of poExport) {
    const erp = acToErp.get((r.ItemCode || "").trim().toUpperCase().replace(/\s+/g, " "));
    if (!erp) continue;
    const k = `${r.DocNo}|${erp.toUpperCase()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const sig = (t) => j(blockFor(parseBedframe(t), findColour));
  let colliding = 0, harmless = 0, riskyKeys = 0, riskyRows = 0;
  const risky = [];
  for (const [k, v] of groups) {
    if (v.length < 2) continue;
    colliding++;
    const survivor = v[v.length - 1];
    const losers = v.slice(0, -1).filter((r) => sig(r.Desc2) !== sig(survivor.Desc2));
    if (!losers.length) { harmless++; continue; }
    riskyKeys++; riskyRows += losers.length;
    risky.push([`  ${k}`,
      `      SURVIVOR dtl=${survivor.DtlKey}  ${j(norm2(survivor.Desc2)).slice(0, 130)}`,
      ...losers.map((r) => `      OVERWRITTEN dtl=${r.DtlKey}  ${j(norm2(r.Desc2)).slice(0, 130)}`)].join("\n"));
  }
  log("");
  log("---- the ceiling: what the PO export could possibly have mis-stamped ----");
  log(`  distinct (DocNo|erp_code) keys in the PO export: ${groups.size}`);
  log(`  keys carrying more than one export row:          ${colliding}`);
  log(`    of those, every row parses IDENTICALLY (harmless): ${harmless}`);
  log(`    of those, the parse DIFFERS from the survivor:     ${riskyKeys}  <- the only keys that can have done damage`);
  log(`  export rows whose parse the survivor overwrote:  ${riskyRows}  <- the CEILING on PO-arm damage`);
  for (const r of risky) log(r);

  // ── the corpus sweep ────────────────────────────────────────────────────────
  const rows = await sql.unsafe(PO_LINE_SQL);
  const verdicts = rows.map((r) => classifyPoLine(r, { byDtl, collided, findColour }));
  const t = tally(verdicts);

  const seg = (name, s) => {
    log(`  ${name}`);
    log(`      lines:                                        ${pad(s.lines, 5)}`);
    log(`      AGREE with their own description2:            ${pad(s.agrees, 5)}`);
    log(`      MISMATCH their own description2:              ${pad(s.mismatch, 5)}`);
    log(`        of which exactly what the collided key      ${pad(s.attributable, 5)}  <- collision damage`);
    log(`        would have produced`);
    log(`      no description2 to check (left alone):        ${pad(s.noText, 5)}`);
    log(`      variants not a jsonb object (#1938 owns):     ${pad(s.badShape, 5)}`);
  };

  log("");
  log("---- every migrated bedframe PO line, against its OWN description2 ----");
  log(`  scope: company 1, item_group='bedframe', header linked to AutoCount - the refresh sweep's own scope`);
  log(`  total lines: ${rows.length}`);
  log("");
  /* The segmentation the answer lives in. A received PO is not "outstanding",
     so the export named only a fraction of these lines; the rest fell through
     to parseBedframe(description2), which cannot collide with anything. */
  seg("SEGMENT 1 - the collided key HIT this line (the export covered it)", t.covered);
  log("");
  seg("SEGMENT 2 - the collided key MISSED (fell through to the line's own text)", t.fellThrough);
  log("");
  seg("BOTH SEGMENTS", t.total);

  log("");
  log("---- is the stored DtlKey corroborated by description2? (section B's question) ----");
  /* Reported for symmetry with the SO arm and NOT used as evidence anywhere
     above: backfill-ac-line-keys.mjs zipped these keys on by line_no under the
     same grouping that collided, so a join on one inherits the guess. */
  log(`  CORROBORATED (description2 == export[DtlKey].Desc2): ${pad(t.provenance.CORROBORATED, 5)}`);
  log(`  CONTRADICTED (different text - key wrong for the row): ${pad(t.provenance.CONTRADICTED, 5)}`);
  log(`  row has no description2 to check against:            ${pad(t.provenance["NO-DESCRIPTION2"], 5)}`);
  log(`  stored DtlKey not present in the export at all:      ${pad(t.provenance["KEY-NOT-IN-EXPORT"], 5)}`);
  log(`  row carries no linked_ac_dtlkey at all:              ${pad(t.provenance["NO-DTLKEY"], 5)}`);
  for (const v of verdicts.filter((x) => x.provenance === "CONTRADICTED").slice(0, 25)) {
    const ex = byDtl.get(Number(v.dtl));
    log(`    ${v.po} ${v.code} dtl=${v.dtl}`);
    log(`        description2 = ${j(norm2(v.d2))}`);
    log(`        export[dtl]  = ${j(norm2(ex ? ex.Desc2 : null))}`);
  }

  /* NAME every exception. A count nobody can act on is how the PO arm stayed an
     open question in the first place. */
  const mismatches = verdicts.filter((v) => v.verdict === "MISMATCH");
  log("");
  log(`---- every mismatching line, named (${mismatches.length}) ----`);
  for (const v of mismatches) {
    log(`  ${v.po} (AC ${v.ac}) ${v.code} status=${v.status} dtl=${v.dtl ?? "-"} prov=${v.provenance}`);
    log(`      export covered this line: ${v.covered}   attributable to the collision: ${v.attributable}`);
    log(`      axes ${v.axes.join(",")}`);
    log(`      now  ${j(v.from)}`);
    log(`      own  ${j(v.to)}`);
    log(`      own description2 ${j(norm2(v.d2))}`);
    log(`      collided-on text ${v.collidedText ? j(v.collidedText) : "(the buggy key never hit this line)"}`);
  }
  if (!mismatches.length) log("  none");

  const noText = verdicts.filter((v) => v.verdict === "NO-TEXT");
  log("");
  log(`---- lines with NO description2, which is why they are left alone (${noText.length}) ----`);
  /* Listed, never guessed at. Position is the fallback this whole exercise
     exists to refuse: a line without its own text has no authority to check
     against, so no repair may touch it. */
  for (const v of noText.slice(0, 100)) log(`  ${v.po} (AC ${v.ac}) ${v.code} dtl=${v.dtl ?? "-"} covered=${v.covered} prov=${v.provenance}`);
  if (noText.length > 100) log(`  ... and ${noText.length - 100} more`);
  if (!noText.length) log("  none");

  const badShape = verdicts.filter((v) => v.verdict === "BAD-SHAPE");
  log("");
  log(`---- lines whose variants jsonb is NOT an object (${badShape.length}) ----`);
  for (const v of badShape) log(`  ${v.po} ${v.code} id=${v.id}`);
  if (!badShape.length) log("  none");

  log("");
  const damage = t.total.attributable;
  log(damage === 0
    ? `VERDICT: the PO arm carries NO collision damage. ${t.total.agrees} of ${rows.length} lines agree with their own description2; ${t.total.mismatch} mismatch and 0 of those hold what the collided key would have produced. The export ceiling was ${riskyRows}.`
    : `VERDICT: ${damage} PO line(s) hold another line's build. Ceiling from the export was ${riskyRows}. repair-collided-po-variants.mjs is the repair.`);
  log("");
  log("DONE (read-only). Nothing was written.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
