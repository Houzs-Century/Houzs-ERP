#!/usr/bin/env node
/* READ-ONLY probe for the owner's 2026-08-31 questions. Four sections:
 *   A. Branding renders "NONE" on a bedframe order (HC-SO-013402) — is the
 *      header carrying the literal text, and how many orders is that?
 *   B. HC-SO-013389 shows no PO although AutoCount links SO-013389 -> PO-010087.
 *      Is the PO imported? Is the line link (so_item_id) set? Why not?
 *   C. "为什么我看每个都是 1S" — census of company-1 SOFA lines by shape:
 *      `<model>-1S` placeholder vs real compartment codes; same for PO lines.
 *   D. Photo coverage: how many SO / PO lines carry photo_urls, sofa first.
 * SELECT only. Exit 0 for every legitimate answer.
 */
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });
const CO = 1;

// ── A. branding ────────────────────────────────────────────────────────────
{
  const rows = await sql`SELECT i.item_code, i.item_group, i.branding AS line_branding,
      p.category::text AS catalog_category, p.branding AS product_branding, h.branding AS header_branding
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = h.company_id
    WHERE i.doc_no = 'HC-SO-013402' AND i.cancelled = false`;
  console.log("A. HC-SO-013402 (the bedframe rendering NONE):");
  for (const r of rows) console.log(`   ${r.item_code} group=${r.item_group} line_branding=${JSON.stringify(r.line_branding)} catalog=${r.catalog_category} product_branding=${JSON.stringify(r.product_branding)} HEADER_branding=${JSON.stringify(r.header_branding)}`);
  const hdr = await sql`SELECT upper(btrim(COALESCE(branding,''))) AS b, COUNT(*)::int AS n
    FROM scm.mfg_sales_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 12`;
  console.log("   imported company-1 SO headers by branding text:");
  for (const r of hdr) console.log(`     ${r.b === '' ? '(blank)' : r.b}: ${r.n}`);
}

// ── B. the missing PO link ─────────────────────────────────────────────────
{
  console.log("\nB. HC-SO-013389 vs AutoCount's SO-013389 -> PO-010087:");
  const po = await sql`SELECT id, po_number, linked_ac_docno, status::text FROM scm.purchase_orders
    WHERE company_id=${CO} AND (linked_ac_docno = 'PO-010087' OR po_number = 'HC-PO-010087')`;
  console.log(`   PO imported? ${po.length ? po.map((p) => `${p.po_number} (ac=${p.linked_ac_docno}, ${p.status})`).join(", ") : "NOT IN ERP"}`);
  if (po.length) {
    const pl = await sql`SELECT item_code, qty, received_qty, linked_ac_dtlkey, so_item_id
      FROM scm.purchase_order_items WHERE purchase_order_id = ${po[0].id}`;
    console.log("   its PO lines:");
    for (const l of pl) console.log(`     ${l.item_code} x${l.qty} recv=${l.received_qty ?? 0} ac_dtlkey=${l.linked_ac_dtlkey ?? "-"} so_item_id=${l.so_item_id ? "SET" : "NULL"}`);
  }
  const sl = await sql`SELECT id, item_code, item_group, qty, linked_ac_dtlkey, remark
    FROM scm.mfg_sales_order_items WHERE doc_no = 'HC-SO-013389' AND cancelled = false`;
  console.log("   the SO's lines (what a PO line must match by code):");
  for (const l of sl) console.log(`     ${l.item_code} [${l.item_group}] x${l.qty} ac_dtlkey=${l.linked_ac_dtlkey ?? "-"} remark=${(l.remark ?? "").slice(0, 60)}`);
}

// ── C. sofa compartment census ─────────────────────────────────────────────
{
  const so = await sql`SELECT
      COUNT(*) FILTER (WHERE i.item_code ~ '-1S$')::int AS placeholder_1s,
      COUNT(*) FILTER (WHERE i.item_code !~ '-1S$')::int AS decomposed,
      COUNT(*)::int AS total
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id=${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
      AND lower(COALESCE(i.item_group,'')) = 'sofa'`;
  console.log(`\nC. company-1 imported SOFA lines: total ${so[0].total}, real compartments ${so[0].decomposed}, "-1S" placeholders ${so[0].placeholder_1s}`);
  const shapes = await sql`SELECT regexp_replace(i.item_code, '^.*?-', '') AS piece, COUNT(*)::int AS n
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id=${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
      AND lower(COALESCE(i.item_group,'')) = 'sofa'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 14`;
  console.log("   most common piece suffixes on SO lines:");
  for (const r of shapes) console.log(`     ${r.piece}: ${r.n}`);
  const pos = await sql`SELECT
      COUNT(*) FILTER (WHERE i.item_code ~ '-1S$')::int AS placeholder_1s,
      COUNT(*)::int AS total
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id=${CO} AND p.linked_ac_docno IS NOT NULL
      AND lower(COALESCE(i.item_group,'')) = 'sofa'`;
  console.log(`   company-1 imported SOFA PO lines: total ${pos[0].total}, "-1S" placeholders ${pos[0].placeholder_1s}`);
}

// ── D. photo coverage ──────────────────────────────────────────────────────
{
  const so = await sql`SELECT lower(COALESCE(i.item_group,'(none)')) AS grp,
      COUNT(*)::int AS lines,
      COUNT(*) FILTER (WHERE COALESCE(array_length(i.photo_urls,1),0) > 0)::int AS with_photos
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id=${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
    GROUP BY 1 ORDER BY 2 DESC`;
  console.log("\nD. photo coverage — imported SO lines by group:");
  for (const r of so) console.log(`   ${r.grp}: ${r.with_photos}/${r.lines} lines carry photos`);
  const po = await sql`SELECT lower(COALESCE(i.item_group,'(none)')) AS grp,
      COUNT(*)::int AS lines,
      COUNT(*) FILTER (WHERE COALESCE(array_length(i.photo_urls,1),0) > 0)::int AS with_photos
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id=${CO} AND p.linked_ac_docno IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC`;
  console.log("   imported PO lines by group:");
  for (const r of po) console.log(`   ${r.grp}: ${r.with_photos}/${r.lines} lines carry photos`);
}
await sql.end();
