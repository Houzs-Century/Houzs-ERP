#!/usr/bin/env node
// One-stop cutover completeness dashboard (read-only). Answers the owner's
// recurring "都齐了吗" with hard numbers in one run:
//   1. AutoCount-outstanding (owner's DO rule, from the checked-in export) vs
//      what the ERP actually has — the to-import diff, sofa-classified
//   2. SP special-size lines with/without dimensions (+ the exact leftovers)
//   3. processed-order bedframe variant completeness (+ exact leftovers)
//   4. PO bedframe variant completeness (+ exact leftovers)
//   5. venue resolution against active project_venues
//   6. coverage: emergency contact / building type / dates / payments
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { isDivanOnly, isDivanlessFrame } from "./lib/variant-axes.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const isSofa = (c) => /SOFA/i.test(c || "");
/* Imported, not re-typed — see scripts/lib/variant-axes.mjs. Local copies of
   these two predicates are how the owner's exemptions came to hold in some
   audits and not others. */
const isDivanless = isDivanlessFrame;
const snip = (s, n = 70) => (s || "").replace(/\s+/g, " ").slice(0, n);

async function main() {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  const acDocs = new Map(); // DocNo -> {lines, sofa}
  for (const r of rows) {
    const d = acDocs.get(r.DocNo) ?? { lines: 0, sofa: 0 };
    d.lines++; if (isSofa(r.ItemCode)) d.sofa++;
    acDocs.set(r.DocNo, d);
  }
  const poRows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-po.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  const acPoDocs = new Set(poRows.filter((r) => !isSofa(r.ItemCode)).map((r) => r.DocNo));

  // ---- 1. outstanding diff ----
  const imp = await sql`SELECT linked_ac_docno ac FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const impSet = new Set(imp.map((r) => r.ac));
  let missPure = [], missMixed = 0, missAllSofa = 0;
  for (const [doc, d] of acDocs) {
    if (impSet.has(doc)) continue;
    if (d.sofa === 0) missPure.push(doc); else if (d.sofa === d.lines) missAllSofa++; else missMixed++;
  }
  const extra = [...impSet].filter((d) => !acDocs.has(d));
  log(`AC outstanding docs (DO rule): ${acDocs.size}; in ERP: ${impSet.size}`);
  log(`MISSING from ERP -> pure non-sofa: ${missPure.length}; mixed: ${missMixed}; all-sofa: ${missAllSofa} (sofa held for the last round)`);
  if (missPure.length) log(`  first pure missing: ${missPure.slice(0, 15).join(", ")}`);
  log(`in ERP but no longer AC-outstanding (delivered since import): ${extra.length}`);

  const impPo = await sql`SELECT linked_ac_docno ac FROM scm.purchase_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const impPoSet = new Set(impPo.map((r) => r.ac));
  const poMiss = [...acPoDocs].filter((d) => !impPoSet.has(d));
  log(`AC outstanding POs (no GRN/PI, non-sofa): ${acPoDocs.size}; in ERP: ${impPoSet.size}; MISSING: ${poMiss.length}${poMiss.length ? ` -> ${poMiss.slice(0, 15).join(", ")}` : ""}`);

  // ---- 2. SP sizes ----
  const sp = await sql`SELECT i.id, i.item_code, i.description2, i.variants->>'size' AS size, h.doc_no
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.item_code ILIKE '%(SP)%'`;
  const spNo = sp.filter((r) => !r.size);
  log(`SP lines: ${sp.length}; with dimensions: ${sp.length - spNo.length}; WITHOUT: ${spNo.length}`);
  for (const r of spNo) log(`   SP no-size ${r.doc_no} ${r.item_code} :: "${snip(r.description2)}"`);

  // ---- 3. processed bedframe completeness ----
  /* "Processed" is the STATE "this order carries a Processing Date", and that
     date lives in processing_date — the column the UI writes and every screen
     reads. It was internal_expected_dd until mig 0286 renamed it, and this
     script's SQL still said so, which is a 42703 the moment anyone dispatches
     it. proceeded_at is stamped only at the IN_PRODUCTION transition,
     so counting it measured a different, smaller population than the one the
     owner sees (2026-08-13). */
  const pb = await sql`SELECT i.id, i.item_code, i.description2, i.variants, i.gap_inches, i.divan_height_inches, i.leg_height_inches, h.doc_no
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND h.processing_date IS NOT NULL AND i.item_group = 'bedframe'`;
  const pbBad = pb.filter((r) => !(r.variants?.colourId) || (!isDivanless(r.item_code) && (r.divan_height_inches == null || r.leg_height_inches == null || (r.gap_inches == null && !isDivanOnly(r.item_code)))));
  log(`processed bedframe lines: ${pb.length}; complete: ${pb.length - pbBad.length}; INCOMPLETE: ${pbBad.length}`);
  for (const r of pbBad.slice(0, 40)) {
    /* The reason string must apply the SAME divanless guard the filter above
       does, or a frame flagged only for its colour prints "colour+divan+leg" and
       sends someone hunting for two measurements that do not exist. */
    const base = !isDivanless(r.item_code);
    const why = [
      !(r.variants?.colourId) && "colour",
      base && r.divan_height_inches == null && "divan",
      base && r.leg_height_inches == null && "leg",
      base && r.gap_inches == null && !isDivanOnly(r.item_code) && "gap",
    ].filter(Boolean).join("+");
    log(`   BF ${r.doc_no} ${r.item_code} missing ${why} :: "${snip(r.description2)}"`);
  }

  // ---- 4. PO bedframe completeness ----
  const pob = await sql`SELECT i.id, i.material_code AS item_code, i.description2, i.variants, i.gap_inches, i.divan_height_inches, i.leg_height_inches, h.po_number AS doc_no
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.item_group = 'bedframe'`;
  const pobBad = pob.filter((r) => !(r.variants?.colourId) || (!isDivanless(r.item_code) && (r.divan_height_inches == null || r.leg_height_inches == null || (r.gap_inches == null && !isDivanOnly(r.item_code)))));
  log(`PO bedframe lines: ${pob.length}; complete: ${pob.length - pobBad.length}; INCOMPLETE: ${pobBad.length}`);
  for (const r of pobBad.slice(0, 20)) log(`   PO-BF ${r.doc_no} ${r.item_code} :: "${snip(r.description2)}"`);

  // ---- 5. venue resolution ----
  const venues = await sql`SELECT name FROM public.project_venues WHERE active = 1 OR active IS NULL`;
  const vset = new Set(venues.map((r) => (r.name || "").trim().toUpperCase()));
  const hv = await sql`SELECT venue, COUNT(*) n FROM scm.mfg_sales_orders
    WHERE company_id = 1 AND linked_ac_docno IS NOT NULL GROUP BY venue`;
  let vBlank = 0, vOk = 0; const vBad = [];
  for (const r of hv) {
    const v = (r.venue || "").trim();
    if (!v) vBlank += Number(r.n);
    else if (vset.has(v.toUpperCase())) vOk += Number(r.n);
    else vBad.push(`${v} (${r.n})`);
  }
  log(`venue: matches active dropdown: ${vOk}; blank(source empty): ${vBlank}; UNRESOLVED values: ${vBad.length}${vBad.length ? ` -> ${vBad.slice(0, 10).join("; ")}` : ""}`);

  // ---- 6. coverage ----
  const [cov] = await sql`SELECT COUNT(*) total,
    COUNT(emergency_contact_phone) emergency,
    COUNT(building_type) building,
    COUNT(processing_date) processed,
    COUNT(customer_delivery_date) deliv
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const [lcov] = await sql`SELECT COUNT(*) total, COUNT(line_delivery_date) with_date
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  log(`coverage of ${cov.total} imported orders: processed=${cov.processed} deliveryDate=${cov.deliv} emergency=${cov.emergency} buildingType=${cov.building}; lines with delivery date: ${lcov.with_date}/${lcov.total}`);

  // ---- 7. processing-date allocation gate impact (ALL companies) ----
  // Owner 2026-08-10: "有 processing date 才来分配,没有 processing date 不分配 —
  // 2990 跟整套系统都是这样子的". The company-1 gate shipped; this measures what
  // flipping it GLOBAL would regress per company before touching 2990's pipeline.
  /* Deliberately still proceeded_at, unlike section 3: this reproduces the gate
     so-stock-allocation.ts actually applies today, and that allocator has not
     been re-pointed yet. Move this in the SAME change that moves it, or the
     number stops describing what production does. */
  const gateRows = await sql`SELECT company_id, COUNT(*) n FROM scm.mfg_sales_orders
    WHERE status = 'READY_TO_SHIP' AND proceeded_at IS NULL GROUP BY company_id ORDER BY company_id`;
  log(`READY_TO_SHIP whose allocator gate column (proceeded_at) is NULL — regresses on the next recompute: ${gateRows.length ? gateRows.map((r) => `company ${r.company_id}: ${r.n}`).join("; ") : "none"}`);

  // ---- 8. fabric master lookup for the hand-parse colour stragglers ----
  // Owner 2026-08-10: "NB KS 都是 fabric 啊" + "silver cream 我们有什么 fabric?"
  // — answer from the master itself so the patch uses verified codes.
  const fab = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours
    WHERE company_id = 1 AND (colour_id ILIKE 'NB%' OR colour_id ILIKE 'KS%'
      OR label ILIKE '%SILVER%' OR label ILIKE '%CREAM%' OR colour_id ILIKE '%SILVER%' OR colour_id ILIKE '%CREAM%' OR fabric_id ILIKE '%MEDITEX%' OR label ILIKE '%MEDITEX%')
    ORDER BY fabric_id, colour_id`;
  log(`fabric master hits (NB*/KS*/silver/cream): ${fab.length}`);
  for (const f of fab.slice(0, 120)) log(`   fabric ${f.fabric_id} | colour ${f.colour_id} | label ${f.label}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
