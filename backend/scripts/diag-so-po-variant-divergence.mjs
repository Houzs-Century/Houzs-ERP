#!/usr/bin/env node
/* READ-ONLY diagnostic: why a migrated SO line's variants disagree with the PO
   raised from it, when both documents carry the SAME AutoCount Desc2.
   SELECTs only - no writes, no DDL, no transaction. Exit 0 for every legitimate
   answer; the output IS the answer (same contract as check-soak-gate.mjs).

   THE DEFECT THIS MEASURES. refresh-so-variants.mjs builds its parsed-Desc2
   lookup as

       parsed.set(`${r.DocNo}|${erp.toUpperCase()}`, parseBedframe(r.Desc2))

   (AutoCount DocNo + ERP item code). That pair is NOT unique per line: one
   order routinely carries several rows of the same SKU in different colours or
   heights. Map.set overwrites, so only the LAST such row's parse survives, and
   the lookup then stamps that single parse onto EVERY database line sharing the
   key. The export carries DtlKey - a per-line identity, unique across all
   13,588 rows - and the database carries it too (linked_ac_dtlkey, #1819), but
   neither side is used.

   The PO arm has the same shape and mostly escapes it: ac-outstanding-po.json.gz
   holds only ~338 rows because a RECEIVED PO is not "outstanding", so nearly
   every PO bedframe line falls through to the per-line description2 fallback,
   which is line-accurate by construction. "Mostly" is a claim, not a
   measurement - section F is the measurement.

   Sections:
     A  the named SO/PO pairs, line by line: is Desc2 really byte-identical, what
        does the CURRENT parser make of each line's OWN DtlKey text, and which
        side does that back.
     B  blast radius: every company-1 migrated bedframe SO line re-derived from
        its OWN DtlKey, counted against what the row holds now.
     C  fabric-code truncation sweep: linked SO/PO line pairs whose bound colour
        on one side is a strict PREFIX of the other's.
     D  duplicated delivery-order lines.
     E  GRN variants: the arm neither refresh script touches.

   SECTION B'S COUNTERPART FOR THE PO ARM IS NOT HERE. It is
   check-po-arm-own-text.mjs, a standalone read-only check, because the repair
   that acts on its verdict (repair-collided-po-variants.mjs) has to measure the
   identical thing before and after it writes - and a measurement that lives
   inside a five-section diagnostic cannot be re-run on its own to show a number
   move. Both import the one classifier in lib/po-arm-own-text.mjs, so the check
   and the repair cannot drift apart.

   DATABASE_URL required.
   SO_DOCS  comma-separated SO doc_no list for section A (default: the 14 + the
            HC-SO-012781 exception + the HC-SO-009600 truncation pair). */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

const DEFAULT_DOCS = [
  "HC-SO-011850", "HC-SO-010777", "HC-SO-011886", "HC-SO-006945", "HC-SO-006572",
  "HC-SO-008117", "HC-SO-012685", "HC-SO-012781", "HC-SO-012209", "HC-SO-012419",
  "HC-SO-012943", "HC-SO-012964", "HC-SO-012949", "HC-SO-009600",
];
const SO_DOCS = (process.env.SO_DOCS || DEFAULT_DOCS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const md5 = (s) => crypto.createHash("md5").update(s == null ? "" : String(s)).digest("hex").slice(0, 10);
const norm2 = (s) => (s || "").replace(/\s+/g, " ").trim();
const j = (v) => JSON.stringify(v);
// variants may be a jsonb STRING or an ARRAY on rows the sofa sweep damaged
const asObj = (v) => {
  let x = v;
  if (typeof x === "string") { try { x = JSON.parse(x); } catch { return {}; } }
  if (Array.isArray(x)) x = x[0];
  return x && typeof x === "object" ? x : {};
};

/* The refresh scripts' variant block, rebuilt here so "what the parser says
   today" is compared on exactly the axes they write. */
function blockFor(bf, findColour) {
  const fc = isPendingColour(bf.color) ? null : findColour(bf.color);
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return {
    colourId: fc ? fc.colour_id : null,
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: tot ? tot + '"' : null,
    size: bf.size || null,
  };
}
const AXES = ["colourId", "gap", "divanHeight", "legHeight", "size"];
const diffAxes = (a, b) => AXES.filter((k) => (a[k] ?? null) !== (b[k] ?? null));

async function main() {
  log("=== SO/PO variant divergence diagnostic (READ-ONLY) ===");

  const soExport = gz("ac-outstanding-so.json.gz");
  const poExport = gz("ac-outstanding-po.json.gz");
  const byDtl = new Map();
  for (const r of [...soExport, ...poExport]) byDtl.set(Number(r.DtlKey), r);
  log(`export rows: SO ${soExport.length}, PO ${poExport.length}; DtlKey index ${byDtl.size}`);

  // the BUGGY key, rebuilt exactly as refresh-so-variants.mjs builds it
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) {
    const f = []; let cur = ""; let q = false;
    for (let i = 0; i < ln.length; i++) { const c = ln[i];
      if (q) { if (c === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ",") { f.push(cur); cur = ""; } else cur += c; } }
    f.push(cur);
    if (f[0]) byAc.set(f[0].trim().toUpperCase().replace(/\s+/g, " "), (f[1] || "").trim());
  }
  const buggy = new Map();
  for (const r of soExport) {
    const erp = byAc.get((r.ItemCode || "").trim().toUpperCase().replace(/\s+/g, " "));
    if (!erp) continue;
    buggy.set(`${r.DocNo}|${erp.toUpperCase()}`, r);   // last write wins - the defect
  }

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  log(`fabric library: ${fcRows.length} colours`);

  // ── A: the named pairs ─────────────────────────────────────────────────────
  log("");
  log("################ SECTION A - the named SO/PO pairs ################");
  for (const doc of SO_DOCS) {
    log("");
    log(`======== ${doc} ========`);
    const soLines = await sql`
      SELECT i.id::text AS id, i.item_code, i.item_group, i.line_no, i.linked_ac_dtlkey,
             i.description2 AS d2, i.variants, i.qty, i.cancelled,
             i.gap_inches, i.divan_height_inches, i.leg_height_inches,
             h.linked_ac_docno AS ac
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.doc_no = ${doc} ORDER BY i.line_no NULLS LAST, i.item_code`;
    if (!soLines.length) { log("  SO NOT FOUND / no lines"); continue; }
    log(`  ac_docno=${soLines[0].ac}  lines=${soLines.length}`);

    const poLines = await sql`
      SELECT pi.id::text AS id, pi.so_item_id::text AS so_item_id, pi.material_code AS code,
             pi.item_group, pi.linked_ac_dtlkey, pi.description2 AS d2, pi.variants, pi.qty,
             p.po_number, p.linked_ac_docno AS ac
        FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
       WHERE pi.so_item_id IN ${sql(soLines.map((l) => l.id))}
       ORDER BY p.po_number`;
    const poBySo = new Map();
    for (const p of poLines) { if (!poBySo.has(p.so_item_id)) poBySo.set(p.so_item_id, []); poBySo.get(p.so_item_id).push(p); }

    for (const l of soLines) {
      const ex = l.linked_ac_dtlkey != null ? byDtl.get(Number(l.linked_ac_dtlkey)) : null;
      const own = ex ? ex.Desc2 : l.d2;                       // this LINE's own text
      const bug = buggy.get(`${l.ac}|${(l.item_code || "").toUpperCase()}`);
      const cur = asObj(l.variants);
      const shouldBe = own != null ? blockFor(parseBedframe(own), findColour) : null;
      const wouldBe = bug ? blockFor(parseBedframe(bug.Desc2), findColour) : null;

      log(`  -- SO line ${l.id.slice(0, 8)} ${l.item_code} line_no=${l.line_no ?? "?"} qty=${l.qty}${l.cancelled ? " CANCELLED" : ""} dtlkey=${l.linked_ac_dtlkey ?? "NULL"}`);
      log(`     own Desc2   [${md5(norm2(own))}] ${j(norm2(own))}`);
      if (bug && norm2(bug.Desc2) !== norm2(own))
        log(`     COLLIDED-ON [${md5(norm2(bug.Desc2))}] ${j(norm2(bug.Desc2))}   <- what the buggy key stamped (DtlKey ${bug.DtlKey})`);
      log(`     variants NOW    ${j(AXES.reduce((o, k) => (o[k] = cur[k] ?? null, o), {}))}`);
      if (shouldBe) log(`     from OWN Desc2  ${j(shouldBe)}`);
      if (wouldBe && shouldBe && diffAxes(wouldBe, shouldBe).length)
        log(`     from COLLIDED   ${j(wouldBe)}  differs on: ${diffAxes(wouldBe, shouldBe).join(",")}`);
      if (shouldBe) {
        const d = diffAxes(cur, shouldBe);
        log(`     SO row vs its OWN Desc2: ${d.length ? `MISMATCH on ${d.join(",")}` : "agrees"}`);
      }
      log(`     inches cols: gap=${l.gap_inches ?? "-"} divan=${l.divan_height_inches ?? "-"} leg=${l.leg_height_inches ?? "-"}`);

      for (const p of poBySo.get(l.id) || []) {
        const pex = p.linked_ac_dtlkey != null ? byDtl.get(Number(p.linked_ac_dtlkey)) : null;
        const pown = pex ? pex.Desc2 : p.d2;
        const pcur = asObj(p.variants);
        const psb = pown != null ? blockFor(parseBedframe(pown), findColour) : null;
        log(`     >> PO ${p.po_number} line ${p.id.slice(0, 8)} ${p.code} qty=${p.qty} dtlkey=${p.linked_ac_dtlkey ?? "NULL"}`);
        log(`        PO Desc2   [${md5(norm2(pown))}] ${j(norm2(pown))}`);
        log(`        DESC2 SO-vs-PO: ${md5(norm2(own)) === md5(norm2(pown)) ? "IDENTICAL" : "*** DIFFERENT ***"}`);
        log(`        PO variants NOW ${j(AXES.reduce((o, k) => (o[k] = pcur[k] ?? null, o), {}))}`);
        if (psb) {
          const pd = diffAxes(pcur, psb);
          log(`        PO row vs its OWN Desc2: ${pd.length ? `MISMATCH on ${pd.join(",")}` : "agrees"}`);
        }
        if (shouldBe) {
          const cd = diffAxes(cur, pcur);
          const truth = diffAxes(shouldBe, pcur);
          log(`        SO-vs-PO conflict axes: ${cd.join(",") || "(none)"} | Desc2 backs PO on: ${AXES.filter((k) => cd.includes(k) && !truth.includes(k)).join(",") || "(none)"} | backs SO on: ${AXES.filter((k) => cd.includes(k) && truth.includes(k) && (shouldBe[k] ?? null) === (cur[k] ?? null)).join(",") || "(none)"}`);
        }
      }
    }
  }

  // ── B: blast radius ────────────────────────────────────────────────────────
  log("");
  log("################ SECTION B - blast radius on ALL migrated bedframe SO lines ################");
  const all = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.linked_ac_dtlkey, i.description2 AS d2,
           i.variants, h.linked_ac_docno AS ac
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  let noKey = 0, noText = 0, agree = 0, mism = 0, attributable = 0;
  const examples = [];
  /* IS THE DtlKey ITSELF TRUSTWORTHY? backfill-ac-line-keys.mjs did not read a
     key off each row - it grouped by (DocNo | item code), the SAME pair that
     collided, and ZIPPED the ordered DtlKeys onto the ERP lines by line_no,
     writing nothing when the two counts disagreed. So "join on linked_ac_dtlkey"
     is a recorded positional guess, not an independently observed fact, and a
     repair resting on it is only as good as that zip.

     description2 is the witness that settles it. The importer wrote it per line
     from the very export row it created that line from (import-ac-outstanding-
     so.mjs, `d2: l.Desc2`), and NEITHER refresh script has ever written the
     column - they only read it. So if the export row addressed by the stored
     DtlKey carries the same text as the row's own description2, the zip
     recovered the original binding and the repair target is a fact. Where they
     disagree the key is wrong for that row and nothing may be written from it. */
  let corrob = 0, contra = 0, noD2 = 0, keyMissingFromExport = 0;
  const contraExamples = [];
  const otherMismatch = [];   // the mismatches the collision does NOT explain
  for (const l of all) {
    if (l.linked_ac_dtlkey == null) { noKey++; continue; }
    const ex = byDtl.get(Number(l.linked_ac_dtlkey));
    const own = ex ? ex.Desc2 : l.d2;
    if (own == null) { noText++; continue; }
    const shouldBe = blockFor(parseBedframe(own), findColour);
    const cur = asObj(l.variants);
    const d = diffAxes(cur, shouldBe);

    // provenance of this row's stored DtlKey, independent of the collision
    let prov;
    if (!ex) { keyMissingFromExport++; prov = "KEY-NOT-IN-EXPORT"; }
    else if (l.d2 == null) { noD2++; prov = "NO-DESCRIPTION2"; }
    else if (norm2(l.d2) === norm2(ex.Desc2)) { corrob++; prov = "CORROBORATED"; }
    else {
      contra++; prov = "CONTRADICTED";
      if (contraExamples.length < 20) contraExamples.push(`${l.doc_no} ${l.item_code} dtl=${l.linked_ac_dtlkey}
        description2 = ${j(norm2(l.d2))}
        export[dtl]  = ${j(norm2(ex.Desc2))}`);
    }

    if (!d.length) { agree++; continue; }
    mism++;
    const bug = buggy.get(`${l.ac}|${(l.item_code || "").toUpperCase()}`);
    let explained = false;
    if (bug && norm2(bug.Desc2) !== norm2(own)) {
      const wouldBe = blockFor(parseBedframe(bug.Desc2), findColour);
      if (!diffAxes(cur, wouldBe).length) {
        explained = true;
        attributable++;
        if (examples.length < 25) examples.push(`${l.doc_no} ${l.item_code} dtl=${l.linked_ac_dtlkey} prov=${prov} axes=${d.join(",")} now=${j(d.reduce((o, k) => (o[k] = cur[k] ?? null, o), {}))} own=${j(d.reduce((o, k) => (o[k] = shouldBe[k] ?? null, o), {}))}`);
      }
    }
    /* The residue. These were counted and never named, so nobody could say what
       they were. Print everything needed to classify each one on sight. */
    if (!explained) {
      otherMismatch.push([
        `${l.doc_no} ${l.item_code} dtl=${l.linked_ac_dtlkey} prov=${prov} axes=${d.join(",")}`,
        `        own Desc2   ${j(norm2(own))}`,
        `        description2 ${j(norm2(l.d2))}`,
        `        collided-on ${bug ? j(norm2(bug.Desc2)) : "(no collided key for this row)"}`,
        `        now  ${j(AXES.reduce((o, k) => (o[k] = cur[k] ?? null, o), {}))}`,
        `        own  ${j(shouldBe)}`,
      ].join("\n"));
    }
  }
  log(`migrated bedframe SO lines: ${all.length}`);
  log(`  no linked_ac_dtlkey (cannot verify): ${noKey}`);
  log(`  no Desc2 text at all:                ${noText}`);
  log(`  row AGREES with its own DtlKey text: ${agree}`);
  log(`  row MISMATCHES its own DtlKey text:  ${mism}`);
  log(`    of which exactly explained by the collided key: ${attributable}  <- the defect's true blast radius`);
  log(`    remaining mismatches (other causes): ${mism - attributable}`);
  log("  examples (up to 25):");
  for (const e of examples) log(`    ${e}`);

  log("");
  log("  --- is the stored DtlKey itself corroborated? (description2 vs export[DtlKey].Desc2) ---");
  log(`    CORROBORATED (same text, zip recovered the binding): ${corrob}`);
  log(`    CONTRADICTED (different text - key is WRONG for that row): ${contra}`);
  log(`    row has no description2 to check against:            ${noD2}`);
  log(`    stored DtlKey not present in the export at all:      ${keyMissingFromExport}`);
  for (const e of contraExamples) log(`      ${e}`);

  log("");
  log(`  --- the ${otherMismatch.length} mismatches the collision does NOT explain ---`);
  for (const e of otherMismatch) log(`    ${e}`);

  // ── C: truncation sweep ────────────────────────────────────────────────────
  log("");
  log("################ SECTION C - fabric-code truncation across linked SO/PO pairs ################");
  const pairs = await sql`
    SELECT s.doc_no AS so_doc, s.item_code AS so_code, s.variants AS so_v, s.item_group AS grp,
           p.po_number AS po_doc, pi.material_code AS po_code, pi.variants AS po_v
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
      JOIN scm.mfg_sales_order_items s ON s.id = pi.so_item_id
      JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
     WHERE h.company_id = 1 AND pi.so_item_id IS NOT NULL`;
  const KEYS = ["colourId", "fabricCode", "colourLabel", "fabricId"];
  const hits = { poShorter: [], soShorter: [] };
  let compared = 0;
  for (const r of pairs) {
    const a = asObj(r.so_v), b = asObj(r.po_v);
    for (const k of KEYS) {
      const x = a[k], y = b[k];
      if (typeof x !== "string" || typeof y !== "string" || !x || !y || x === y) continue;
      compared++;
      if (x.startsWith(y)) hits.poShorter.push(`${r.so_doc}/${r.po_doc} grp=${r.grp} ${k}: SO=${j(x)} PO=${j(y)}  <- PO truncated`);
      else if (y.startsWith(x)) hits.soShorter.push(`${r.so_doc}/${r.po_doc} grp=${r.grp} ${k}: SO=${j(x)} PO=${j(y)}  <- SO truncated`);
    }
  }
  log(`linked SO/PO line pairs: ${pairs.length}; differing string fields compared: ${compared}`);
  log(`  PO value is a strict PREFIX of the SO's: ${hits.poShorter.length}`);
  for (const h of hits.poShorter.slice(0, 60)) log(`    ${h}`);
  log(`  SO value is a strict PREFIX of the PO's: ${hits.soShorter.length}`);
  for (const h of hits.soShorter.slice(0, 60)) log(`    ${h}`);

  /* Is the shorter value a TRUNCATION, or a SECOND LIBRARY ROW for the same
     physical colour? findColour only ever returns a whole scm.fabric_colours
     row, so if both spellings exist there the disagreement is a duplicate in
     the library, not a string being clipped - and the remedy is completely
     different. Print the library rows for every series named in a prefix hit. */
  const series = new Set();
  for (const h of [...hits.poShorter, ...hits.soShorter]) {
    const m = /SO="([A-Z0-9]+)/i.exec(h); if (m) series.add(m[1].replace(/[0-9]+$/, "").toUpperCase());
    const m2 = /SO="([A-Z]{2,6}\s?[0-9]{2,4})/i.exec(h); if (m2) series.add(m2[1].toUpperCase());
  }
  log(`  library rows for the series involved (${[...series].join(", ") || "none"}):`);
  for (const s of series) {
    const rows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours
                            WHERE company_id = 1 AND (UPPER(colour_id) LIKE ${s + "%"} OR UPPER(fabric_id) LIKE ${s + "%"})
                            ORDER BY colour_id`;
    for (const r of rows) log(`    fabric_id=${j(r.fabric_id)} colour_id=${j(r.colour_id)} label=${j(r.label)}`);
    if (!rows.length) log(`    (no rows matching ${s})`);
  }

  /* The BO315 series turned out to hold BOTH "BO315-5" and "BO315-5-FOSSIL" -
     the same physical colour entered twice, once bare and once with its name.
     Any line binding to one and its counterpart binding to the other reads as a
     disagreement forever. Census the whole library so the owner can see the
     latent exposure in one read rather than one document at a time. */
  log("");
  log("  library colour pairs where one colour_id is the other plus a trailing NAME:");
  const allFc = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const byId = new Map(allFc.map((r) => [String(r.colour_id).toUpperCase(), r]));
  const dupPairs = [];
  for (const r of allFc) {
    const id = String(r.colour_id).toUpperCase();
    const m = /^(.*?[0-9])[\s-]+[A-Z][A-Z ]*$/.exec(id);
    if (m && byId.has(m[1])) dupPairs.push([m[1], id, r.fabric_id]);
  }
  const bySeries = new Map();
  for (const [bare, named, fid] of dupPairs) {
    if (!bySeries.has(fid)) bySeries.set(fid, []);
    bySeries.get(fid).push(`${bare} = ${named}`);
  }
  log(`  ${dupPairs.length} duplicate pairs across ${bySeries.size} series`);
  for (const [fid, list] of [...bySeries.entries()].sort((a, b) => b[1].length - a[1].length))
    log(`    ${fid} (${list.length}): ${list.join(" | ")}`);
  // how many live lines are bound to either half of a duplicate pair?
  const halves = [...new Set(dupPairs.flatMap(([a, b]) => [a, b]))];
  if (halves.length) {
    const exposure = await sql`
      SELECT UPPER(v) AS cid, COUNT(*)::int AS n FROM (
        SELECT i.variants ->> 'colourId' AS v FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = 1 AND jsonb_typeof(i.variants) = 'object'
        UNION ALL
        SELECT pi.variants ->> 'colourId' FROM scm.purchase_order_items pi
          JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
         WHERE p.company_id = 1 AND jsonb_typeof(pi.variants) = 'object') t
       WHERE UPPER(v) = ANY(${sql.array(halves)}) GROUP BY 1 ORDER BY 2 DESC`;
    log(`  live SO+PO lines bound to either half of a duplicate pair: ${exposure.reduce((a, r) => a + r.n, 0)}`);
    for (const r of exposure) log(`    ${r.cid}: ${r.n}`);
  }

  /* The handover reported a GRN on HC-PO-009576 recording divanHeight 151".
     Both PO lines read 14" and 12", so print what the GRN actually holds. */
  log("");
  log("  GRN variant heights on the documents named in the audit:");
  const grn = await sql`
    SELECT g.grn_number, gi.material_code AS code, gi.variants, p.po_number
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
     WHERE p.po_number = ANY(${sql.array(["HC-PO-009576", "HC-PO-009428", "HC-PO-009273"])})`;
  for (const r of grn) {
    const v = asObj(r.variants);
    log(`    ${r.po_number} ${r.grn_number} ${r.code}: divanHeight=${j(v.divanHeight ?? null)} gap=${j(v.gap ?? null)} legHeight=${j(v.legHeight ?? null)} colourId=${j(v.colourId ?? null)}`);
  }
  if (!grn.length) log("    (no GRN lines found for those POs)");

  // ── E: the GRN variant arm, which nothing has ever swept ───────────────────
  log("");
  log("################ SECTION E - GRN variants: the arm neither refresh script touches ################");
  /* refresh-so-variants.mjs writes mfg_sales_order_items and
     refresh-po-variants.mjs writes purchase_order_items. NOTHING writes
     grn_items.variants after create-migrated-documents.mjs copies it off the PO
     line at receipt. A GRN is a SNAPSHOT of the PO at that moment, so a value
     that was wrong when the snapshot was taken stays wrong after the PO line
     itself is repaired - and no existing check looks. */
  const NUMAX = ["gap", "divanHeight", "legHeight", "totalHeight"];
  const RANGE = { gap: [1, 24], divanHeight: [1, 24], legHeight: [0, 12], totalHeight: [1, 48] };
  const numOf = (v) => { const m = /^\s*(\d+(?:\.\d+)?)/.exec(String(v ?? "")); return m ? parseFloat(m[1]) : null; };
  const implausible = (k, v) => {
    const n = numOf(v); if (n == null) return false;
    const [lo, hi] = RANGE[k]; return n < lo || n > hi;
  };
  /* The tell that a figure came out of a FABRIC CODE rather than a tape measure:
     it equals a digit run inside the colour bound on the very same row.
     "PC151-01" yields 1", which sits inside every plausible range - a bounds
     check alone is blind to it, which is why the shape is tested two ways. */
  const codeNums = (v) => new Set(([v.colourId, v.fabricCode, v.fabricId, v.colourLabel]
    .filter((x) => typeof x === "string").join(" ").match(/\d+/g) ?? []).map(Number));

  const grnAll = await sql`
    SELECT g.grn_number, g.migrated_no_stock AS mig, gi.id::text AS id, gi.material_code AS code,
           gi.item_group AS grp, gi.variants AS gv,
           pi.id::text AS po_item_id, pi.variants AS pv, pi.description2 AS pd2,
           pi.linked_ac_dtlkey AS pdtl, p.po_number
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      LEFT JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
      LEFT JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
     WHERE g.company_id = ${1} AND jsonb_typeof(gi.variants) = 'object'`;
  log(`GRN lines carrying an object-shaped variants block: ${grnAll.length}`);

  const buckets = { artefact: [], driftPlausible: [], sameAsParent: 0, noParent: 0, clean: 0 };
  const axisHist = new Map();      // "axis=value" -> count, so the normal range is visible not assumed
  for (const r of grnAll) {
    const gv = asObj(r.gv);
    for (const k of NUMAX) if (gv[k] != null) {
      const key = `${k}=${gv[k]}`; axisHist.set(key, (axisHist.get(key) ?? 0) + 1);
    }
    const cn = codeNums(gv);
    const suspectAxes = NUMAX.filter((k) => gv[k] != null
      && (implausible(k, gv[k]) || cn.has(numOf(gv[k]))));
    if (!r.po_item_id) { if (suspectAxes.length) buckets.noParent++; else buckets.clean++; continue; }

    const pv = asObj(r.pv);
    const pex = r.pdtl != null ? byDtl.get(Number(r.pdtl)) : null;
    const parentText = pex ? pex.Desc2 : r.pd2;
    const parentShould = parentText != null ? blockFor(parseBedframe(parentText), findColour) : null;
    const drift = NUMAX.concat("colourId").filter((k) => (gv[k] ?? null) !== (pv[k] ?? null));
    if (!drift.length) { buckets.sameAsParent++; if (!suspectAxes.length) buckets.clean++; continue; }

    const row = {
      line: `${r.grn_number} <- ${r.po_number ?? "?"} ${r.code} grp=${r.grp ?? "-"} mig=${r.mig}`,
      grn: j(NUMAX.concat("colourId").reduce((o, k) => (o[k] = gv[k] ?? null, o), {})),
      po: j(NUMAX.concat("colourId").reduce((o, k) => (o[k] = pv[k] ?? null, o), {})),
      should: parentShould ? j(parentShould) : "(parent has no source text)",
      text: j(norm2(parentText)),
      drift: drift.join(","), suspect: suspectAxes.join(",") || "(none)",
    };
    /* PARSE ARTEFACT vs REAL HISTORY. Correcting a GRN is only "restoring the
       snapshot" when the GRN's own value could not have been a measurement -
       it is out of range, or it is a digit run of the colour on the same row -
       AND the parent PO line now agrees with its own AutoCount text. Anything
       else could be a genuine difference at receipt and is left alone. */
    const parentSound = parentShould
      && !NUMAX.some((k) => (pv[k] ?? null) !== (parentShould[k] ?? null));
    if (suspectAxes.length && parentSound) buckets.artefact.push(row);
    else buckets.driftPlausible.push(row);
  }
  log(`  GRN line agrees with its parent PO line on every axis: ${buckets.sameAsParent}`);
  log(`  GRN line has no parent PO line and a suspect axis:     ${buckets.noParent}`);
  log("");
  log(`  A. PARSE ARTEFACT - suspect figure, parent PO sound (correcting RESTORES the snapshot): ${buckets.artefact.length}`);
  for (const r of buckets.artefact) {
    log(`    ${r.line}`);
    log(`       suspect axes: ${r.suspect}   drift vs parent: ${r.drift}`);
    log(`       GRN  ${r.grn}`);
    log(`       PO   ${r.po}`);
    log(`       text ${r.text}`);
  }
  log("");
  log(`  B. DRIFT, both sides plausible - COULD be real history, LEFT UNTOUCHED: ${buckets.driftPlausible.length}`);
  for (const r of buckets.driftPlausible.slice(0, 40)) {
    log(`    ${r.line}`);
    log(`       drift vs parent: ${r.drift}   suspect axes: ${r.suspect}`);
    log(`       GRN  ${r.grn}`);
    log(`       PO   ${r.po}`);
    log(`       should ${r.should}`);
  }
  if (buckets.driftPlausible.length > 40) log(`    ... and ${buckets.driftPlausible.length - 40} more`);
  log("");
  log("  every distinct numeric axis value present on a GRN line (so the normal range is observed, not assumed):");
  for (const [k, n] of [...axisHist.entries()].sort((a, b) => b[1] - a[1])) log(`    ${k}  x${n}`);

  /* The same misparse shape on the two arms that ARE swept. If the parser wrote
     a fabric code into a height here it did so wherever that text appears. */
  log("");
  log("  the same shape on the SO and PO arms (a numeric axis equal to a digit run of the row's own colour, or out of range):");
  for (const [label, rows] of [
    ["SO", await sql`SELECT i.doc_no AS doc, i.item_code AS code, i.variants AS v
                       FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                      WHERE h.company_id = ${1} AND jsonb_typeof(i.variants) = 'object'`],
    ["PO", await sql`SELECT p.po_number AS doc, pi.material_code AS code, pi.variants AS v
                       FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
                      WHERE p.company_id = ${1} AND jsonb_typeof(pi.variants) = 'object'`],
  ]) {
    const hits = [];
    for (const r of rows) {
      const v = asObj(r.v); const cn = codeNums(v);
      const ax = NUMAX.filter((k) => v[k] != null && (implausible(k, v[k]) || cn.has(numOf(v[k]))));
      if (ax.length) hits.push(`${r.doc} ${r.code} ${ax.map((k) => `${k}=${v[k]}`).join(" ")} colour=${j(v.colourId ?? null)}`);
    }
    log(`    ${label}: ${hits.length} of ${rows.length} lines`);
    for (const h of hits.slice(0, 30)) log(`      ${h}`);
    if (hits.length > 30) log(`      ... and ${hits.length - 30} more`);
  }

  // ── D: duplicated delivery-order lines ─────────────────────────────────────
  /* HC-SO-001920 shows ONE ordered ELEPAHNE-(SK) against FOUR delivery lines.
     The SO->DO drill already proved zero inventory movements, so the question
     left is whether the duplication is one bad document or a systemic import
     defect - and whether any movement reaches these DOs by another source type. */
  log("");
  log("################ SECTION D - duplicated delivery-order lines ################");
  const dupDo = process.env.DUP_DO_SO || "HC-SO-001920";
  const dhdr = await sql`
    SELECT id::text AS id, do_number, UPPER(COALESCE(status::text,'')) AS status, do_date::text AS d,
           migrated_no_stock, linked_ac_docno, created_at::text AS created
      FROM scm.delivery_orders WHERE so_doc_no = ${dupDo} ORDER BY do_date`;
  for (const d of dhdr) {
    log(`  ${d.do_number} status=${d.status} date=${d.d} migrated_no_stock=${d.migrated_no_stock} ac=${d.linked_ac_docno ?? "-"} created=${d.created}`);
    const anyMove = await sql`
      SELECT source_doc_type, COUNT(*)::int AS n, COALESCE(SUM(ABS(qty)),0)::numeric AS q
        FROM scm.inventory_movements WHERE source_doc_id = ${d.id}::uuid GROUP BY source_doc_type`;
    log(`     movements referencing this DO by ANY source_doc_type: ${anyMove.length ? anyMove.map((m) => `${m.source_doc_type}=${m.n} (qty ${m.q})`).join(", ") : "NONE"}`);
    const dl = await sql`
      SELECT item_code, qty, so_item_id::text AS so_item_id, COUNT(*)::int AS copies
        FROM scm.delivery_order_items WHERE delivery_order_id = ${d.id}::uuid
       GROUP BY item_code, qty, so_item_id HAVING COUNT(*) > 1`;
    for (const x of dl) log(`     EXACT-DUPLICATE line: ${x.item_code} qty=${x.qty} x${x.copies} copies (so_item_id ${x.so_item_id ? x.so_item_id.slice(0, 8) : "NULL"})`);
  }
  // system-wide: how many DOs carry exact-duplicate lines, migrated vs not
  const sysDup = await sql`
    SELECT d.migrated_no_stock AS mig, COUNT(DISTINCT d.id)::int AS docs, SUM(t.extra)::int AS extra_lines
      FROM scm.delivery_orders d
      JOIN (SELECT delivery_order_id, item_code, qty, so_item_id, COUNT(*) - 1 AS extra
              FROM scm.delivery_order_items
             GROUP BY delivery_order_id, item_code, qty, so_item_id HAVING COUNT(*) > 1) t
        ON t.delivery_order_id = d.id
     WHERE d.company_id = 1 GROUP BY d.migrated_no_stock`;
  log("  system-wide (company 1) delivery orders carrying EXACT-duplicate lines:");
  for (const s of sysDup) log(`    migrated_no_stock=${s.mig}: ${s.docs} documents, ${s.extra_lines} surplus lines`);
  if (!sysDup.length) log("    none");
  // do any of those duplicated-line DOs actually move stock?
  const dupMoves = await sql`
    SELECT COUNT(*)::int AS n
      FROM scm.inventory_movements m
     WHERE m.source_doc_type = 'DO' AND m.source_doc_id IN (
       SELECT DISTINCT delivery_order_id FROM scm.delivery_order_items
        GROUP BY delivery_order_id, item_code, qty, so_item_id HAVING COUNT(*) > 1)`;
  log(`  inventory movements posted by ANY duplicated-line DO: ${dupMoves[0].n}`);

  /* THE REMEDIATION LIST. The owner has to approve a correction to real
     delivery documents, so name every surplus line once, with the document it
     sits on and the twin it duplicates. A count is not something anyone can
     approve. */
  log("");
  log("  EXACT remediation list - every surplus delivery-order line, by document:");
  const dupLines = await sql`
    SELECT d.do_number, d.id::text AS do_id, d.migrated_no_stock AS mig,
           UPPER(COALESCE(d.status::text, '')) AS status, d.so_doc_no, d.linked_ac_docno AS ac,
           t.item_code, t.qty, t.so_item_id::text AS so_item_id, t.copies, t.ids
      FROM scm.delivery_orders d
      JOIN (SELECT delivery_order_id, item_code, qty, so_item_id,
                   COUNT(*)::int AS copies,
                   ARRAY_AGG(id::text ORDER BY id) AS ids
              FROM scm.delivery_order_items
             GROUP BY delivery_order_id, item_code, qty, so_item_id
            HAVING COUNT(*) > 1) t ON t.delivery_order_id = d.id
     WHERE d.company_id = ${1}
     ORDER BY d.do_number, t.item_code`;
  let surplus = 0;
  const docsSeen = new Set();
  for (const r of dupLines) {
    docsSeen.add(r.do_number);
    surplus += r.copies - 1;
    log(`    ${r.do_number} (SO ${r.so_doc_no ?? "-"}, AC ${r.ac ?? "-"}, status=${r.status}, migrated=${r.mig})`);
    log(`       ${r.item_code} qty=${r.qty} so_item_id=${r.so_item_id ? r.so_item_id.slice(0, 8) : "NULL"} - ${r.copies} copies, ${r.copies - 1} SURPLUS`);
    log(`       keep ${r.ids[0]}   surplus ${r.ids.slice(1).join(", ")}`);
  }
  log(`  TOTAL: ${docsSeen.size} documents, ${surplus} surplus lines, ${dupLines.length} duplicate groups`);

  /* A surplus line only costs the owner money if something reads it. Prove what
     does: the SO's delivered arithmetic counts non-cancelled DO lines by
     so_item_id, so a duplicate inflates "delivered" even with no movement. */
  const overDel = await sql`
    SELECT s.doc_no, s.item_code, s.qty AS ordered,
           COALESCE(SUM(di.qty), 0)::numeric AS do_qty
      FROM scm.mfg_sales_order_items s
      JOIN scm.delivery_order_items di ON di.so_item_id = s.id
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
      JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
     WHERE h.company_id = ${1} AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     GROUP BY s.doc_no, s.item_code, s.qty
    HAVING COALESCE(SUM(di.qty), 0) > s.qty
     ORDER BY s.doc_no`;
  log("");
  log(`  sales-order lines whose non-cancelled DO quantity EXCEEDS the ordered quantity: ${overDel.length}`);
  for (const r of overDel) log(`    ${r.doc_no} ${r.item_code}: ordered ${r.ordered}, delivered ${r.do_qty}`);

  log("");
  log("DONE (read-only). Nothing was written.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
