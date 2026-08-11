#!/usr/bin/env node
/* Fill the BLANK sofa variant axes from AutoCount's own Desc2, on every
 * purchase-order line and every PROCEEDED sales-order line.
 *
 * Owner, 2026-08-11: "我们需要把这些旧的 SO 还有 PO 的 variants 全部补齐" and, on
 * scope, "如果没有 proceed 没关系 如果 proceed 了的单 和 PO 就要尽量补齐".
 *
 * WHY THE FABRIC LIBRARY BEING TIDIED NEVER FIXED THIS. Two independent causes,
 * both measured on production 2026-08-11:
 *   1. No sweep has EVER written a sofa variant. `refresh-po-variants.mjs` and
 *      `refresh-so-variants.mjs` are hard-filtered to `item_group='bedframe'`,
 *      which is why bedframe reads 405/406 complete on colour and sofa 175/219.
 *   2. `parseSofa` read a colour only when it was LABELLED ("Col: X"). An
 *      unlabelled code — "BO315-21 (PEARL)/28"/2L" — was discarded as an
 *      unrecognised structure token. So even a sweep that had run would have
 *      read nothing.
 * 85 of the 86 blank colour axes hold NO value rather than an unresolvable one,
 * which is the evidence that the library was never the blocker.
 *
 * THE RULES THIS OBEYS
 *   - It FILLS ONLY. A key that already carries a value is never touched: staff
 *     have been editing these documents for months and an operator's own
 *     correction outranks a re-parse of the same old text.
 *   - A colour is written only when scm.fabric_colours can CONFIRM the code.
 *     A code the library confirms is a copy of what AutoCount wrote; a code it
 *     cannot confirm is a guess, and this migration does not guess. Unconfirmed
 *     codes are printed as the CREATE list instead.
 *   - EXACT is applied by default. A code that only resolves through the fuzzy
 *     matcher needs FUZZY=1, because a match is not a copy — it is the owner's
 *     call whether "B0315-1 pearl" is "BO315-1-PEARL".
 *   - It writes no compartment. Desc2 names no build on 18 of the 21 distinct
 *     shapes, and where it does the notation is older than the current
 *     vocabulary. Compartments come from the photo, in a separate pass.
 *   - A Ready Stock line is skipped (owner: "Ready stock 的就不需要").
 *   - The merge is `variants || patch` in the DATABASE through db.json(), so an
 *     unknown key survives by construction and nothing is double-encoded
 *     (docs/jsonb-double-encoding-coe.md).
 *
 * The dry-run prints EXACTLY the list apply consumes — one plan, two readers —
 * because a dry-run that says LEFT AT ZERO for a line apply would have priced
 * is how this cutover produced wrong rows before.
 *
 *   DATABASE_URL   required
 *   COMPANY        default 1
 *   FUZZY=1        also apply the codes that resolve only through the matcher
 *   APPLY=1        write. Dry-run otherwise.
 */
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour, normColour } from "./lib/fabric-colour-match.mjs";
import { buildSofaVariantPatch, mergeVariantPatch, OWNED_SOFA_KEYS } from "./lib/variant-merge.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = process.env.APPLY === "1";
const FUZZY = process.env.FUZZY === "1";
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const modelOf = (code) => {
  const c = normColour(code);
  const dash = c.indexOf("-");
  const base = dash < 0 ? c : c.slice(0, dash);
  return SOFA_MODEL_ALIAS[base] || base;
};
/* "SL0095 Ready Stock" is a stock note, not a build to specify. */
const isReadyStock = (d2) => /\bready\s*stock\b/i.test(d2 || "");

async function main() {
  log(`sofa variant backfill from AutoCount Desc2 — company ${CO}`);
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  fuzzy=${FUZZY ? "applied" : "reported only"}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => normColour(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(normColour(m + s)));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const exactRow = new Map();
  for (const r of fcRows) for (const k of [normColour(r.colour_id), normColour(r.label)]) if (k && !exactRow.has(k)) exactRow.set(k, r);
  log(`fabric library: ${fcRows.length} colour rows`);

  /* The predicate parseSofa consults for an UNLABELLED code. It answers only
     "does the library know this string", never "what should it be". */
  const knownColour = (t) => (exactRow.has(normColour(t)) || findColour(t) ? String(t).trim() : null);

  const po = (await sql`
    SELECT i.id, p.po_number AS doc, i.material_code AS code, i.description2 AS d2, i.variants
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY p.po_number`).map((r) => ({ ...r, table: "purchase_order_items", scope: "PO" }));

  const so = (await sql`
    SELECT i.id, h.doc_no AS doc, i.item_code AS code, i.description2 AS d2, i.variants
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa'
       AND h.proceeded_at IS NOT NULL
     ORDER BY h.doc_no, i.line_no`).map((r) => ({ ...r, table: "mfg_sales_order_items", scope: "SO" }));

  const plan = [];
  const toCreate = new Map();
  const held = [];
  let skippedReady = 0, skippedPending = 0, nothingBlank = 0, noRead = 0, heldOnly = 0;

  for (const r of [...po, ...so]) {
    const d2 = (r.d2 || "").trim();
    if (!d2) { noRead++; continue; }
    if (isReadyStock(d2)) { skippedReady++; continue; }
    if (isPendingColour(d2)) { skippedPending++; continue; }

    const ps = parseSofa(d2, modelOf(r.code), reclOf(modelOf(r.code)), { knownColour });
    if (!ps.color && !ps.size) { noRead++; continue; }

    let fc = null, how = null;
    if (ps.color) {
      const hit = exactRow.get(normColour(ps.color));
      if (hit) { fc = hit; how = "exact"; }
      else {
        const f = findColour(ps.color);
        if (f) { fc = f; how = "fuzzy"; }
        else {
          const k = String(ps.color).trim();
          toCreate.set(normColour(k), { code: k, doc: r.doc, line: r.code, d2 });
        }
      }
    }
    /* Ask FIRST whether this line has a blank axis at all. Reporting a held
       colour for a line that is already filled inflates the hold list with
       lines nothing would have touched — the first run of this script said 338
       when the real number of blocked lines is far smaller. */
    const wouldFill = buildSofaVariantPatch(ps, fc, r.variants);
    if (!wouldFill) { nothingBlank++; continue; }

    if (how === "fuzzy" && !FUZZY) {
      if (wouldFill.colourId) held.push({ ...r, from: ps.color, to: `${fc.fabric_id} / ${fc.colour_id}` });
      fc = null;                       // still allowed to fill the seat size
    }

    const patch = buildSofaVariantPatch(ps, fc, r.variants);
    if (!patch) { heldOnly++; continue; }
    plan.push({ ...r, patch, from: ps.color, how, evidence: ps.colorEvidence || d2.slice(0, 90), size: ps.size });
  }

  log("");
  log("════════════════════════════════════════════════════════════════════════");
  log(`THE PLAN — ${plan.length} line(s). Apply writes exactly this and nothing else.`);
  log("════════════════════════════════════════════════════════════════════════");
  for (const p of plan) {
    const bits = Object.entries(p.patch).map(([k, v]) => `${k}=${v}`).join("  ");
    log(`${p.scope} ${p.doc}  ${p.code}`);
    log(`   ${bits}`);
    log(`   from ${JSON.stringify(p.evidence)}${p.how ? ` [${p.how}]` : ""}`);
  }

  if (held.length) {
    log("");
    log(`HELD — ${held.length} colour(s) resolve only through the matcher. Re-run with FUZZY=1 to apply them.`);
    const seen = new Set();
    for (const h of held) {
      const k = `${h.from}=>${h.to}`;
      if (seen.has(k)) continue; seen.add(k);
      log(`   "${h.from}"  ->  ${h.to}`);
    }
  }

  if (toCreate.size) {
    log("");
    log(`NOT IN THE FABRIC LIBRARY — ${toCreate.size} code(s). These are the ones to CREATE.`);
    for (const v of toCreate.values()) log(`   "${v.code}"   first seen on ${v.doc} ${v.line}`);
  }

  log("");
  log(`sofa lines read           PO ${po.length} / proceeded SO ${so.length}`);
  log(`  skipped, Ready Stock    ${skippedReady}`);
  log(`  skipped, TBC/KIV        ${skippedPending}`);
  log(`  nothing blank to fill   ${nothingBlank}`);
  log(`  Desc2 says nothing      ${noRead}`);
  log(`  blocked, colour held    ${heldOnly}`);
  log(`  TO FILL                 ${plan.length}`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  let merged = 0, skippedShape = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const n = await mergeVariantPatch(tx, { table: p.table, id: p.id, patch: p.patch, owned: OWNED_SOFA_KEYS });
      if (n) merged++; else skippedShape++;
    }
  });
  log("");
  log(`APPLIED — ${merged} line(s) merged; ${skippedShape} skipped because variants is not a jsonb object.`);
  log("Counts are RETURNING, not a command tag. Confirm with an independent read before believing them.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
