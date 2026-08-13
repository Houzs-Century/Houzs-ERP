#!/usr/bin/env node
// The two questions the owner asks before every go/no-go, answered with live
// numbers instead of memory (2026-08-10):
//
//   1. Is EVERY outstanding AutoCount SO in the ERP? Every outstanding PO?
//      (plus every PO raised from an outstanding SO, received or not — a
//      received PO is what makes its SO line READY.)
//   2. Does every BEDFRAME and SOFA line — on sales orders AND on purchase
//      orders — carry its variants?
//
// The AutoCount side is data/ac-outstanding-now.json.gz, a list of document
// numbers read straight from the live AutoCount database. Re-export it with
// scratchpad/export-outstanding-now.py when you want a fresher answer; the file
// records what AutoCount said at export time and nothing here pretends
// otherwise.
//
// NOTE - QUESTION 1 IS ASKED TWICE, AT TWO ALTITUDES, AND THE SECOND ONE IS WHY.
// Until 2026-08-10 this file compared DOCUMENT-NUMBER SETS only, so it reported
// "PO 407 = 407 MISSING 0" while 51 purchase-order LINES were absent: both PO
// importers are idempotent at document level, an already-present document is
// skipped WHOLE, and the 26 sofa lines riding 25 MIXED documents were never
// written. The document was there. The lines were not, and this check could not
// see it. Section 1b is that blind spot closed - it counts lines per document
// and names the shortfall.
//
// Read-only. One statement at a time, no writes, no DDL.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { RECEIVED_INDETERMINATE, buildFamilies, claimErpRows, familyShortfall, groupByDoc, isSofaCode, mergeAcPoLines, normSku } from "./lib/po-line-topup-core.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8"));

async function main() {
  const ac = gz("ac-outstanding-now.json.gz");

  log("═══ 1. Is everything outstanding in AutoCount also in the ERP? ═══");
  const soRows = await sql`SELECT linked_ac_docno, status FROM scm.mfg_sales_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const soIn = new Map(soRows.map((r) => [r.linked_ac_docno, r.status]));
  const soMissing = ac.so.filter((d) => !soIn.has(d));
  /* A cancelled or delivered order in the ERP is present but not usable, and
     the owner's question is about usable orders — so count it separately
     rather than letting "imported" hide it. */
  const DEAD = new Set(["CANCELLED", "CLOSED", "DELIVERED", "SHIPPED", "INVOICED"]);
  const soDead = ac.so.filter((d) => soIn.has(d) && DEAD.has(String(soIn.get(d))));
  log(`SO: AutoCount outstanding ${ac.so.length}; in ERP ${ac.so.length - soMissing.length}; MISSING ${soMissing.length}; present but cancelled/closed in ERP ${soDead.length}`);
  for (const d of soMissing.slice(0, 20)) log(`   missing SO: ${d}`);
  if (soMissing.length > 20) log(`   ... and ${soMissing.length - 20} more`);

  const poRows = await sql`SELECT linked_ac_docno, status FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const poIn = new Map(poRows.map((r) => [r.linked_ac_docno, r.status]));
  const wantPo = [...new Set([...(ac.po ?? []), ...(ac.so_linked_po ?? [])])];
  const poMissing = wantPo.filter((d) => !poIn.has(d));
  log(`PO: AutoCount wants ${wantPo.length} (outstanding ${ac.po.length} + raised-from-an-outstanding-SO ${ac.so_linked_po.length}); in ERP ${wantPo.length - poMissing.length}; MISSING ${poMissing.length}`);
  for (const d of poMissing.slice(0, 20)) log(`   missing PO: ${d}`);
  if (poMissing.length > 20) log(`   ... and ${poMissing.length - 20} more`);

  log("");
  log("═══ 1b. Line level: is every AutoCount LINE represented in the ERP? ═══");

  /* PO side. Union of both PO exports, deduped on DtlKey (they overlap on 121
     documents and agree line-for-line there). The test is decoder-independent:
     one AutoCount line can only ever produce ONE OR MORE ERP rows - a sofa line
     decomposes into its compartments, everything else is one-for-one - so an
     ItemCode holding FEWER ERP rows than it has AutoCount lines is proof of
     missing rows whatever the sofa decoder does today. Rows are claimed by
     supplier_sku, falling back to material_code for the 225 migrated lines that
     carry no supplier_sku at all; the full rule is in lib/po-line-topup-core.mjs
     and is the SAME code the top-up repair writes from, deliberately. */
  const acPo = mergeAcPoLines(gz("ac-outstanding-po.json.gz"), gz("ac-so-linked-pos.json.gz"));
  const acPoByDoc = groupByDoc(acPo);
  const mapCsv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).slice(1);
  const erpByAc = new Map();
  for (const ln of mapCsv) { const f = ln.split(","); if (f[0]) erpByAc.set(normSku(f[0]), (f[1] || "").trim()); }
  const resolveErp = (itemCode) => {
    const erp = erpByAc.get(normSku(itemCode));
    if (!erp) return {};
    if (!isSofaCode(itemCode)) return { code: erp };
    const m = erp.replace(/-1S$/i, "");
    return { code: erp, sofaModel: SOFA_MODEL_ALIAS[m] || m };
  };
  const HAS_DTLKEY = (await sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'purchase_order_items' AND column_name = 'linked_ac_dtlkey'`).length > 0;
  const poItemRows = HAS_DTLKEY
    ? await sql`SELECT p.linked_ac_docno ac, i.supplier_sku, i.material_code, i.linked_ac_dtlkey
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`
    : await sql`SELECT p.linked_ac_docno ac, i.supplier_sku, i.material_code, NULL::bigint AS linked_ac_dtlkey
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const poItemsByAc = new Map();
  for (const r of poItemRows) {
    if (!poItemsByAc.has(r.ac)) poItemsByAc.set(r.ac, []);
    poItemsByAc.get(r.ac).push({ supplierSku: r.supplier_sku, materialCode: r.material_code, linkedAcDtlKey: r.linked_ac_dtlkey });
  }
  let poDocsChecked = 0, poDocsAbsent = 0, poAcLines = 0, poErpRows = 0, poShort = 0, poUnassigned = 0, poAmbiguous = 0;
  const poShortDocs = [];
  /* Of the shortfall, how much the top-up would REFUSE to write rather than
     invent a received quantity. topup-ac-po-lines.yml is added by that PR and
     `workflow_dispatch` needs the workflow on the default branch, so its own
     DRY-RUN cannot be dispatched before merge - this check is the only
     read-only path to the number that exists today, and it must be read before
     anyone believes a stale DRY-RUN. */
  let poShortWithheld = 0;
  const poWithheldFamilies = [];
  for (const [doc, lines] of acPoByDoc) {
    if (!poIn.has(doc)) { poDocsAbsent++; continue; } // a PO present with ZERO lines still gets counted below
    poDocsChecked++;
    const rows = poItemsByAc.get(doc) ?? [];
    poAcLines += lines.length;
    poErpRows += rows.length;
    const families = buildFamilies(lines, resolveErp);
    const claim = claimErpRows(families, rows);
    poUnassigned += claim.unassigned.length;
    poAmbiguous += claim.ambiguous.length;
    const r = familyShortfall(families);
    if (r.short > 0) {
      poShort += r.short;
      poShortDocs.push({ doc, acLines: lines.length, erpRows: rows.length,
        missing: r.families.filter((f) => f.short > 0).map((f) => `${f.itemCode} x${f.short}`) });
      for (const f of r.families) {
        if (f.short <= 0) continue;
        const blind = f.lines.filter((l) => l.receivedSource === RECEIVED_INDETERMINATE).length;
        if (!blind) continue;
        poShortWithheld += f.short;
        poWithheldFamilies.push({ doc, itemCode: f.itemCode, short: f.short, blind, spans: f.lines.find((l) => l.receivedSource === RECEIVED_INDETERMINATE)?.aggregateSpans ?? null });
      }
    }
  }
  log(`PO lines: AutoCount ${poAcLines} across ${poDocsChecked} documents present in the ERP; ERP rows ${poErpRows}; AutoCount lines with NO ERP row at all: ${poShort} across ${poShortDocs.length} documents`);
  log(`   (AutoCount PO documents not in the ERP at all: ${poDocsAbsent} - those are section 1's number, not a line shortfall)`);
  log(`   claimed by linked_ac_dtlkey ${HAS_DTLKEY ? poItemRows.filter((r) => r.linked_ac_dtlkey != null).length : "n/a (0273 not applied here)"}; rows no AutoCount ItemCode on their document could claim: ${poUnassigned}; claimable by two ItemCodes so claimed by neither: ${poAmbiguous}`);
  log(`   of that shortfall, WITHHELD by the top-up because the export has no per-line received quantity: ${poShortWithheld} line(s) across ${poWithheldFamilies.length} ItemCode(s) - these stay missing ON PURPOSE`);
  for (const w of poWithheldFamilies) log(`      ${w.doc} "${w.itemCode}": short ${w.short}, ${w.blind} line(s) blind, GrQty spans ${w.spans ?? "?"} line(s)${w.spans > 1 ? " - PROVABLY inflated" : ""}`);
  for (const d of poShortDocs.slice(0, 30)) log(`   ${d.doc}: AutoCount ${d.acLines} lines / ERP ${d.erpRows} rows -> short ${d.missing.join(", ")}`);
  if (poShortDocs.length > 30) log(`   ... and ${poShortDocs.length - 30} more documents`);

  /* SO side. A sales-order line carries no AutoCount code - item_code is the ERP
     code and nothing on the row names the source line - so the supplier_sku
     family test cannot run here. The one-line-at-least-one-row invariant still
     holds, but against the right denominator, and the right denominator is NOT
     every line of the order.
     WHAT PRODUCTION ACTUALLY HOLDS, measured 2026-08-10: an imported order
     carries the AutoCount lines that are still OUTSTANDING (Qty >
     TransferedQty), not the delivered ones. SO-000013 is the clearest read - 8
     AutoCount lines, 7 of them fully transferred, and exactly the 1 untransfered
     line in the ERP. Counting all 13,588 lines calls 243 lines missing on 65
     orders and every one of them is a delivered line that was never meant to
     come; counting the 13,342 outstanding ones leaves exactly 1. The ALL-lines
     figure is printed too, so the denominator is visible rather than assumed. */
  const acSo = gz("ac-outstanding-so.json.gz");
  const qn = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  const acSoAll = new Map(), acSoOutstanding = new Map();
  for (const r of acSo) {
    acSoAll.set(r.DocNo, (acSoAll.get(r.DocNo) ?? 0) + 1);
    if (qn(r.Qty) > qn(r.TransferedQty)) acSoOutstanding.set(r.DocNo, (acSoOutstanding.get(r.DocNo) ?? 0) + 1);
  }
  const soLineCounts = await sql`SELECT h.linked_ac_docno ac, COUNT(i.doc_no)::int n
    FROM scm.mfg_sales_orders h LEFT JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL GROUP BY 1`;
  let soAcAll = 0, soAcOut = 0, soErpRows = 0, soShort = 0, soDocsChecked = 0;
  const soShortDocs = [];
  for (const r of soLineCounts) {
    if (!acSoAll.has(r.ac)) continue;
    soDocsChecked++;
    const all = acSoAll.get(r.ac);
    const out = acSoOutstanding.get(r.ac) ?? 0;
    soAcAll += all; soAcOut += out; soErpRows += r.n;
    if (r.n < out) {
      soShort += out - r.n;
      soShortDocs.push({ doc: r.ac, all, out, erpRows: r.n });
    }
  }
  log(`SO lines: AutoCount ${soAcAll} across ${soDocsChecked} orders present in the ERP, of which ${soAcOut} are still outstanding; ERP rows ${soErpRows}; MISSING ${soShort} across ${soShortDocs.length} orders`);
  for (const d of soShortDocs.slice(0, 30)) log(`   ${d.doc}: AutoCount outstanding ${d.out} lines (of ${d.all}) / ERP ${d.erpRows} rows -> short ${d.out - d.erpRows}`);
  if (soShortDocs.length > 30) log(`   ... and ${soShortDocs.length - 30} more orders`);

  log("");
  log("═══ 2. Do bedframe and sofa lines carry their variants? ═══");

  /* BEDFRAME completeness = the four things the factory sheet needs: fabric
     colour, gap, divan height, leg height. A blank colour is only acceptable
     while the order has not been proceeded (owner: 那些当他们 proceed 单的时候，
     他们会补掉的), so PROCESSED orders are counted apart.
     Proceeded is the STATE "carries a Processing Date", and that date is
     internal_expected_dd — what the UI writes and what soProcessingLocked and
     MRP read. proceeded_at is only the IN_PRODUCTION stamp, so it named a
     narrower population than the rule the owner stated. */
  const bfSo = await sql`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL)::int proc,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL AND (i.variants->>'colourId') IS NULL)::int proc_no_colour,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL AND (i.variants->>'gap') IS NULL)::int proc_no_gap,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL AND (i.variants->>'divanHeight') IS NULL)::int proc_no_divan,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL AND (i.variants->>'legHeight') IS NULL)::int proc_no_leg
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.item_group = 'bedframe'
      AND COALESCE(i.cancelled,false) = false AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  const b = bfSo[0];
  log(`SO bedframe lines: ${b.total} (processed ${b.proc}). On PROCESSED orders missing -> colour ${b.proc_no_colour}; gap ${b.proc_no_gap}; divan ${b.proc_no_divan}; leg ${b.proc_no_leg}`);

  const bfPo = await sql`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE (i.variants->>'colourId') IS NULL)::int no_colour,
      COUNT(*) FILTER (WHERE (i.variants->>'gap') IS NULL)::int no_gap,
      COUNT(*) FILTER (WHERE (i.variants->>'divanHeight') IS NULL)::int no_divan,
      COUNT(*) FILTER (WHERE (i.variants->>'legHeight') IS NULL)::int no_leg
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND i.item_group = 'bedframe'`;
  const bp = bfPo[0];
  log(`PO bedframe lines: ${bp.total}. Missing -> colour ${bp.no_colour}; gap ${bp.no_gap}; divan ${bp.no_divan}; leg ${bp.no_leg}`);

  /* SOFA completeness is different: the variant that matters is the BUILD, and
     an undecodable build is signed "SOFA UNPARSED" in the line notes rather
     than guessed. So count placeholders, then seat size and colour. */
  const sfSo = await sql`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL)::int proc,
      COUNT(*) FILTER (WHERE COALESCE(i.remark,'') LIKE '%SOFA UNPARSED%')::int placeholder,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL AND (i.variants->>'seatHeight') IS NULL)::int proc_no_size,
      COUNT(*) FILTER (WHERE h.internal_expected_dd IS NOT NULL AND (i.variants->>'colourId') IS NULL)::int proc_no_colour
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.item_group = 'sofa'
      AND COALESCE(i.cancelled,false) = false AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  const s = sfSo[0];
  log(`SO sofa lines: ${s.total} (processed ${s.proc}); UNPARSED placeholders ${s.placeholder}. On PROCESSED orders missing -> seat size ${s.proc_no_size}; colour ${s.proc_no_colour}`);

  const sfPo = await sql`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE COALESCE(i.notes,'') LIKE '%SOFA UNPARSED%')::int placeholder,
      COUNT(*) FILTER (WHERE (i.variants->>'seatHeight') IS NULL)::int no_size,
      COUNT(*) FILTER (WHERE (i.variants->>'colourId') IS NULL)::int no_colour
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND i.item_group = 'sofa'`;
  const sp = sfPo[0];
  log(`PO sofa lines: ${sp.total}; UNPARSED placeholders ${sp.placeholder}. Missing -> seat size ${sp.no_size}; colour ${sp.no_colour}`);

  /* Anything whose item_code is not a catalogue code shows "No products match"
     in the picker and cannot be picked, costed or shipped. Owner spotted one
     live, so it gets a permanent lens. */
  log("");
  log("═══ 3. Lines whose item_code is not a product in the catalogue ═══");
  const orphan = await sql`SELECT i.doc_no, i.item_code, COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = ${CO}
    WHERE h.company_id = ${CO} AND p.code IS NULL AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
    GROUP BY 1, 2 ORDER BY 1 LIMIT 40`;
  const [{ n: orphanTotal }] = await sql`SELECT COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = ${CO}
    WHERE h.company_id = ${CO} AND p.code IS NULL AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`SO lines with no matching product: ${orphanTotal}`);
  for (const r of orphan) log(`   ${r.doc_no}: "${r.item_code}"`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
