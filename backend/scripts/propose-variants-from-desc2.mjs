#!/usr/bin/env node
/* READ-ONLY. What can be COPIED out of AutoCount's own Desc2 into the variant
 * axes that are blank today, on every purchase-order line and every PROCEEDED
 * sales-order line?
 *
 * Owner, 2026-08-11: "我们需要把这些旧的 SO 还有 PO 的 variants 全部补齐 ...
 * 你先尝试从 AutoCount 那边的 Description 2 抽出来。"
 *
 * THIS PROPOSES. IT NEVER WRITES. There is deliberately no APPLY, because the
 * governing rule is that a migration copies and never computes: every row this
 * prints carries the EXACT substring it was taken from, so the proposal can be
 * refuted by reading the source rather than trusted.
 *
 * WHAT IT WILL NOT DO
 *   - It will not propose a COMPARTMENT. 18 of the 21 distinct Desc2 shapes on
 *     the undecoded sofa lines name no build at all, and the three that do use
 *     an older notation (1 ELT / T + NA + 2ER) whose mapping onto the current
 *     vocabulary only the owner knows. PO-009469 proves the ambiguity is real:
 *     its Desc2 says "1+2(28'INCH)" and the document holds 1A(LHF)+2A(RHF) —
 *     a bare "1+2" cannot say whether the pieces are handed. Compartments come
 *     from the photo, in a separate pass.
 *   - It will not overwrite a value that is already there. Only blank axes.
 *   - It will not invent a colour the fabric library cannot confirm. Those are
 *     printed under UNRESOLVED so they are visible, not silently dropped.
 *
 * Every axis is judged blank with missingVariantAxes — the same tested mirror
 * of the app's own confirm gate the completeness audit uses — so this script
 * and that audit cannot disagree about which axis needs filling.
 *
 *   DATABASE_URL   required
 *   COMPANY        default 1
 */
import postgres from "postgres";
import { missingVariantAxes } from "./lib/variant-axes.mjs";
import { buildFabricColourIndex, isPendingColour, normColour } from "./lib/fabric-colour-match.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());

/* ── the extractors ───────────────────────────────────────────────────────────
   Each returns { value, evidence } where evidence is the LITERAL substring of
   Desc2 the value was cut from. A rule that cannot show its evidence does not
   belong here. Ordered most-specific first; the first hit wins. */

const COLOUR_RULES = [
  // {COL:CH141-8 ARMY}  [DAYBED/COL:J9833-2]  Col: Harring 02# beige
  [/(?:^|[\s/[{(\n])(?:col(?:our|or)?)\s*[:：]\s*([^/\n\]}]+)/i, "labelled Col:/colour:"],
  // "Size:28”/Col:Modenza-Houston Cream" handled above; bare leading code:
  // "BO315-21/32”"  "B0315-21"  "AM275-7"  "HR805-90"
  [/^\s*([A-Z]{1,4}\s?\d{2,4}\s?[-–]\s?\d{1,3}(?:\s*[A-Z][A-Z ]{0,14})?)(?=\s*[/\n]|$)/i, "bare code at the start"],
];

function extractColour(d2) {
  for (const [re, why] of COLOUR_RULES) {
    const m = re.exec(d2 || "");
    if (!m) continue;
    let v = m[1].replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
    if (!v || v.length > 40) continue;
    return { value: v, evidence: m[0].trim(), why };
  }
  return null;
}

const SEAT_RULES = [
  [/SEAT\s*HEIGHT\s*[:：]\s*(\+?\s*\d{1,2})\s*(?:"|”|inch)/i, "SEAT HEIGHT:"],
  [/\bSize\s*[:：]\s*(\d{2})\s*(?:"|”|inch)?/i, "Size:"],
  [/(\d{2})\s*(?:"|”|''|inch|icnh)\s*(?:per\s*(?:seat|set))/i, "N inch per seat/set"],
  [/\(\s*(\d{2})\s*(?:"|”|''|inch|icnh)\s*\)/i, "(N inch) in brackets"],
  [/(?:^|[\s/(])(\d{2})\s*(?:"|”|''|inch|icnh)\b/i, "a bare N inch"],
];

function extractSeat(d2) {
  for (const [re, why] of SEAT_RULES) {
    const m = re.exec(d2 || "");
    if (!m) continue;
    const raw = m[1].replace(/\s+/g, "");
    const n = Number(raw.replace("+", ""));
    if (!Number.isFinite(n) || n < 14 || n > 60) continue;
    return { value: `${raw}"`, evidence: m[0].trim(), why };
  }
  return null;
}

/* Bedframe: divan / leg / gap. AutoCount writes them as a set on one line. */
const BF_RULES = {
  divanHeight: [[/DIVAN\s*[:：]?\s*(\d{1,2}(?:\.\d)?)\s*(?:"|”|inch)/i, "DIVAN: N\""]],
  legHeight: [
    [/(\d{1,2}(?:\.\d)?)\s*(?:"|”|inch)\s*\(?\s*LEG\s*\)?/i, "N\" (LEG)"],
    [/LEG\s*[:：]?\s*(\d{1,2}(?:\.\d)?)\s*(?:"|”|inch)/i, "LEG: N\""],
    [/\(\s*NO\s*LEG\s*\)/i, "(NO LEG)"],
  ],
  gap: [[/\b(?:M['’]?\s*)?GAP\s*[:：]?\s*(\d{1,2}(?:\.\d)?)\s*(?:"|”|inch)?/i, "GAP: N\""]],
};

function extractBedframe(axis, d2) {
  for (const [re, why] of BF_RULES[axis] || []) {
    const m = re.exec(d2 || "");
    if (!m) continue;
    if (/NO\s*LEG/i.test(m[0])) return { value: '0"', evidence: m[0].trim(), why };
    if (!m[1]) continue;
    return { value: `${m[1]}"`, evidence: m[0].trim(), why };
  }
  return null;
}

/* Split Desc2 into the tokens a human would read as separate facts, and return
   the FIRST that the fabric library confirms. Tokens that are plainly a size
   ("28\"", "30 inch") or a piece list ("1P+1NA+1P") are skipped before the
   library is consulted, so a numeric coincidence cannot become a colour. */
function unlabelledSofaColour(d2, idSet, findColour) {
  const parts = String(d2 || "").split(/[/\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const raw of parts) {
    const t = raw.replace(/\s*\((?:feather|foam)\)\s*/i, "").trim();
    if (!t || t.length > 40) continue;
    if (/^\d+\s*(?:"|”|inch)?$/i.test(t)) continue;              // a size
    if (/^(?:size|seat)\b/i.test(t)) continue;                    // a labelled size
    if (/^[\d+ACLNPRST()+\s]+$/i.test(t) && /\+|\(/.test(t)) continue; // a piece list
    if (!/\d/.test(t)) continue;                                  // a fabric code carries digits
    const exact = idSet.has(normColour(t));
    const bare = t.replace(/\s*\([^)]*\)\s*/g, "").trim();        // "BO315-21 (PEARL)" -> "BO315-21"
    const exactBare = !exact && bare && idSet.has(normColour(bare));
    const fuzzy = exact || exactBare ? null : (findColour(t) || (bare ? findColour(bare) : null));
    if (!exact && !exactBare && !fuzzy) continue;
    return {
      value: exact ? t : exactBare ? bare : t,
      evidence: raw,
      why: exact || exactBare ? "unlabelled code, exact in fabric library" : "unlabelled code, matched in fabric library",
    };
  }
  return null;
}

const modelOf = (code) => {
  const c = normColour(code);
  const dash = c.indexOf("-");
  const base = dash < 0 ? c : c.slice(0, dash);
  return SOFA_MODEL_ALIAS[base] || base;
};
let reclOf = () => false;

const AXIS_KIND = {
  fabricCode: "colour", colourId: "colour", fabricId: "colour", fabricColor: "colour",
  seatHeight: "seat", depth: "seat",
  divanHeight: "divan", legHeight: "leg", gap: "gap",
};

async function main() {
  log(`READ-ONLY variant proposal from AutoCount Desc2 — company ${CO}. NOTHING IS WRITTEN.`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => normColour(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  reclOf = (m) => RECL.some((s) => codeSet.has(normColour(m + s)));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const idSet = new Set(fcRows.flatMap((r) => [normColour(r.colour_id), normColour(r.label)]).filter(Boolean));
  log(`fabric library: ${fcRows.length} colour rows`);

  const po = (await sql`
    SELECT i.id, p.po_number AS doc, p.linked_ac_docno AS ac, i.material_code AS code,
           i.item_group AS grp, i.description2 AS d2, i.variants,
           COALESCE(array_length(i.photo_urls, 1), 0) AS photos
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')
     ORDER BY p.po_number`).map((r) => ({ ...r, scope: "PO" }));

  const so = (await sql`
    SELECT i.id, h.doc_no AS doc, h.linked_ac_docno AS ac, i.item_code AS code,
           i.item_group AS grp, i.description2 AS d2, i.variants,
           COALESCE(array_length(i.photo_urls, 1), 0) AS photos
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')
       AND h.proceeded_at IS NOT NULL
     ORDER BY h.doc_no, i.line_no`).map((r) => ({ ...r, scope: "SO(proceeded)" }));

  const proposals = [];
  const noEvidence = [];
  let linesTouched = 0;

  for (const r of [...po, ...so]) {
    const miss = missingVariantAxes(r.grp, r.variants, r.code);
    if (!miss.length) continue;
    const d2 = txt(r.d2);
    // TBC/KIV is a real state - "not chosen yet" - never a gap to fill.
    if (isPendingColour(d2)) { noEvidence.push({ ...r, axes: miss.map((a) => a.label), why: "source says TBC/KIV" }); continue; }

    /* Read with the SAME parsers the writers use. A second, ad-hoc regex set
       here would be a new source of truth, and a wrong value that looks parsed
       is exactly the failure this migration keeps producing. Where the shared
       parser is silent, the local rules below act only as a NAMED fallback, so
       the report can say which of the two answered. */
    const ps = r.grp === "sofa" ? parseSofa(d2, modelOf(r.code), reclOf(modelOf(r.code))) : null;
    const pb = r.grp === "bedframe" ? parseBedframe(d2) : null;
    const shared = {
      colour: txt(ps?.color ?? pb?.color) || null,
      seat: ps?.size ? String(ps.size) : null,
      divan: pb?.divan != null ? `${pb.divan}"` : null,
      leg: pb?.leg != null ? `${pb.leg}"` : null,
      gap: pb?.gap != null ? `${pb.gap}"` : null,
    };

    const kinds = new Set(miss.map((a) => AXIS_KIND[a.key] || a.key));
    const got = [];
    for (const kind of kinds) {
      let hit = null;
      if (shared[kind]) hit = { value: shared[kind], evidence: d2.slice(0, 120), why: r.grp === "sofa" ? `parseSofa (conf ${ps.conf})` : "parseBedframe" };
      else if (kind === "colour" && r.grp === "sofa") {
        /* parseSofa reads a colour only when it is LABELLED ("Col: X"). An
           UNLABELLED code — "BO315-21 (PEARL)/28"/2L" — is discarded as an
           unrecognised structure token, which is the whole missing-Fabrics
           bucket on sofa. Recover it, but only where the token resolves to a
           row that actually exists in scm.fabric_colours: a code the library
           can confirm is a copy, a code it cannot is a guess. */
        hit = unlabelledSofaColour(d2, idSet, findColour) || extractColour(d2);
      } else if (kind === "colour") hit = extractColour(d2);
      else if (kind === "seat") hit = extractSeat(d2);
      else if (kind === "divan") hit = extractBedframe("divanHeight", d2);
      else if (kind === "leg") hit = extractBedframe("legHeight", d2);
      else if (kind === "gap") hit = extractBedframe("gap", d2);
      if (!hit) continue;
      let resolves = null;
      if (kind === "colour") {
        const exact = idSet.has(normColour(hit.value));
        const fuzzy = exact ? null : findColour(hit.value);
        resolves = exact ? "exact" : fuzzy ? `fuzzy -> ${fuzzy.fabric_id} / ${fuzzy.colour_id}` : "UNRESOLVED";
      }
      got.push({ kind, ...hit, resolves });
    }
    if (!got.length) { noEvidence.push({ ...r, axes: miss.map((a) => a.label), why: d2 ? "Desc2 says nothing about it" : "Desc2 is empty" }); continue; }
    linesTouched++;
    proposals.push({ ...r, missing: miss.map((a) => a.label), got, d2 });
  }

  log("");
  log("════════════════════════════════════════════════════════════════════════");
  log("PROPOSED — a value that is written in AutoCount's own Desc2");
  log("════════════════════════════════════════════════════════════════════════");
  for (const p of proposals) {
    log(`${p.scope} ${p.doc} (AC ${p.ac || "-"})  ${p.grp} ${p.code}   missing: ${p.missing.join(", ")}`);
    log(`   Desc2: ${JSON.stringify(p.d2)}`);
    for (const g of p.got) {
      log(`   -> ${g.kind.padEnd(7)} = ${String(g.value).padEnd(24)} from ${JSON.stringify(g.evidence)} [${g.why}]${g.resolves ? `  library: ${g.resolves}` : ""}`);
    }
  }

  log("");
  log("════════════════════════════════════════════════════════════════════════");
  log("NO EVIDENCE IN Desc2 — these need the photo, or the owner");
  log("════════════════════════════════════════════════════════════════════════");
  for (const r of noEvidence) {
    log(`${r.scope} ${r.doc} (AC ${r.ac || "-"})  ${r.grp} ${r.code}   missing: ${r.axes.join(", ")}   photos: ${r.photos}   (${r.why})`);
    if (txt(r.d2)) log(`   Desc2: ${JSON.stringify(txt(r.d2))}`);
  }

  const byKind = new Map();
  for (const p of proposals) for (const g of p.got) {
    const k = `${g.kind}${g.resolves === "UNRESOLVED" ? " (colour NOT in library)" : ""}`;
    byKind.set(k, (byKind.get(k) || 0) + 1);
  }
  log("");
  log("════════════════════════════════════════════════════════════════════════");
  log("TALLY");
  log("════════════════════════════════════════════════════════════════════════");
  log(`  lines examined                     ${po.length + so.length}  (PO ${po.length} / proceeded SO ${so.length})`);
  log(`  lines with a blank required axis   ${proposals.length + noEvidence.length}`);
  log(`  lines a Desc2 value can fill       ${linesTouched}`);
  log(`  lines with NO evidence in Desc2    ${noEvidence.length}   (of which ${noEvidence.filter((r) => r.photos > 0).length} already carry a photo)`);
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) log(`    ${k.padEnd(36)} ${n}`);
  log("");
  log("  NOTHING WAS WRITTEN. This script has no APPLY by design.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
