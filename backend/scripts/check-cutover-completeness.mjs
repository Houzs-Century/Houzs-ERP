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
// Read-only. One statement at a time, no writes, no DDL.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

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
  log("═══ 2. Do bedframe and sofa lines carry their variants? ═══");

  /* BEDFRAME completeness = the four things the factory sheet needs: fabric
     colour, gap, divan height, leg height. A blank colour is only acceptable
     while the order has not been proceeded (owner: 那些当他们 proceed 单的时候，
     他们会补掉的), so PROCESSED orders are counted apart. */
  const bfSo = await sql`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL)::int proc,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL AND (i.variants->>'colourId') IS NULL)::int proc_no_colour,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL AND (i.variants->>'gap') IS NULL)::int proc_no_gap,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL AND (i.variants->>'divanHeight') IS NULL)::int proc_no_divan,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL AND (i.variants->>'legHeight') IS NULL)::int proc_no_leg
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
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL)::int proc,
      COUNT(*) FILTER (WHERE COALESCE(i.notes,'') LIKE '%SOFA UNPARSED%')::int placeholder,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL AND (i.variants->>'seatHeight') IS NULL)::int proc_no_size,
      COUNT(*) FILTER (WHERE h.proceeded_at IS NOT NULL AND (i.variants->>'colourId') IS NULL)::int proc_no_colour
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
