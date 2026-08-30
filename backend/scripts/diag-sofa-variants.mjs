#!/usr/bin/env node
/* READ-ONLY: how complete are the sofa VARIANTS we extracted (owner 2026-08-31:
 * "seat size col leg 等等 这些全部 variant 你都 extract 出来了?"). Fill rates for
 * company-1 imported sofa lines, SO side and PO side, per axis. */
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });
const CO = 1;
const nz = (col) => sql`COALESCE(NULLIF(btrim(${sql.unsafe(col)}), ''), NULL) IS NOT NULL`;

const so = await sql`SELECT COUNT(*)::int AS lines,
    COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(i.variants->>'seatHeight'),''), NULLIF(btrim(i.variants->>'depth'),'')) IS NOT NULL)::int AS seat,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'colourId'),'') IS NOT NULL)::int AS colour_id,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'colourLabel'),'') IS NOT NULL)::int AS colour_text,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'legHeight'),'') IS NOT NULL)::int AS leg,
    COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(i.variants->'specials','[]'::jsonb)) > 0)::int AS specials
  FROM scm.mfg_sales_order_items i
  JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
  WHERE h.company_id=${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
    AND lower(COALESCE(i.item_group,''))='sofa'`;
const s = so[0];
console.log(`SO sofa lines ${s.lines}: seat size ${s.seat} | colour(library) ${s.colour_id} | colour(text) ${s.colour_text} | leg height ${s.leg} | specials ${s.specials}`);

const po = await sql`SELECT COUNT(*)::int AS lines,
    COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(i.variants->>'seatHeight'),''), NULLIF(btrim(i.variants->>'depth'),'')) IS NOT NULL)::int AS seat,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'colourId'),'') IS NOT NULL)::int AS colour_id,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'colourLabel'),'') IS NOT NULL)::int AS colour_text,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'legHeight'),'') IS NOT NULL)::int AS leg,
    COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(i.variants->'specials','[]'::jsonb)) > 0)::int AS specials
  FROM scm.purchase_order_items i
  JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
  WHERE p.company_id=${CO} AND p.linked_ac_docno IS NOT NULL
    AND lower(COALESCE(i.item_group,''))='sofa'`;
const p = po[0];
console.log(`PO sofa lines ${p.lines}: seat size ${p.seat} | colour(library) ${p.colour_id} | colour(text) ${p.colour_text} | leg height ${p.leg} | specials ${p.specials}`);

const keys = await sql`SELECT k, COUNT(*)::int AS n FROM (
    SELECT jsonb_object_keys(i.variants) AS k
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no
    WHERE h.company_id=${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
      AND lower(COALESCE(i.item_group,''))='sofa' AND i.variants IS NOT NULL) t
  GROUP BY 1 ORDER BY 2 DESC`;
console.log(`\nvariant keys actually present on SO sofa lines:`);
for (const r of keys) console.log(`   ${r.k}: ${r.n}`);

const bedframe = await sql`SELECT COUNT(*)::int AS lines,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'gap'),'') IS NOT NULL)::int AS gap,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'legHeight'),'') IS NOT NULL)::int AS leg,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'divanHeight'),'') IS NOT NULL)::int AS divan,
    COUNT(*) FILTER (WHERE NULLIF(btrim(i.variants->>'colourId'),'') IS NOT NULL)::int AS colour
  FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no
  WHERE h.company_id=${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
    AND lower(COALESCE(i.item_group,''))='bedframe'`;
const b = bedframe[0];
console.log(`\nBEDFRAME SO lines ${b.lines}: gap ${b.gap} | leg ${b.leg} | divan ${b.divan} | colour(library) ${b.colour}`);
await sql.end();
