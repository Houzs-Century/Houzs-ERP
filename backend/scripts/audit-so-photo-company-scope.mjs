#!/usr/bin/env node
/*
 * READ-ONLY safety proof for the SO photo company-scoping fix.
 * =============================================================
 *
 * WHY THIS EXISTS. `GET /mfg-sales-orders/:docNo/items/:itemId/photos/:photoKey`
 * and its `/signed` sibling run on a SERVICE-ROLE client (RLS bypassed) and
 * authorise ONLY item -> doc_no -> photo_urls membership. Neither applies
 * scopeToCompany, so any authenticated SCM user who knows a docNo + itemId +
 * photoKey can read ANOTHER company's photo. The PO route
 * (mfg-purchase-orders.ts) and the consignment route (consignment-orders.ts)
 * both scope; the SO pair is the odd one out.
 *
 * Adding the company predicate to the item lookup is a one-line fix — and
 * exactly the kind of one-line fix that silently BLANKS every photo in the app
 * if the data does not support it. The route matches on the ITEM row, so the
 * fix is only safe if, for every photo key that exists today, the item's
 * company_id equals the company_id of the SO header that owns it. Where those
 * two disagree, a user of the owning company would be refused a photo they can
 * see right now.
 *
 * So this script asks the ONE question that decides whether the fix ships:
 *
 *     Would every photo key that is reachable today still be reachable
 *     by a user of the company that owns its order?
 *
 * It is SELECT-only. It writes nothing, creates nothing, and touches no R2
 * object. It reads scm.mfg_sales_order_items, scm.mfg_sales_orders, and — as
 * live CONTROLS — the two tables whose photo routes are ALREADY scoped and
 * demonstrably working in production (purchase_order_items,
 * consignment_sales_order_items). If the controls are clean and the SO table
 * is clean by the same measure, the fix carries the risk they already carry:
 * none observed.
 *
 * Exit 1 if any SO photo row would become unreachable. That is a REPORT, not a
 * ship signal — a nonzero exit means report the rows, not hide the photos.
 */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARN  ${m}`);

async function main() {
  const companies = await sql`SELECT id, code FROM public.companies ORDER BY id`;
  notice(`companies: ${companies.map((c) => `${c.id}=${c.code}`).join(", ")}`);

  /* -- 1. THE DECIDING QUERY -------------------------------------------
     Every SO item that carries photos, joined to its header, bucketed by
     whether the item's company_id agrees with the header's. `aligned` rows
     stay reachable after the fix. Anything else is a photo the fix would
     hide from the very company that owns it.

     photo_urls is typed text[] here; to_jsonb + jsonb_array_length measures
     it without caring whether a given vintage stored text[] or jsonb. */
  const [verdict] = await sql`
    SELECT
      count(*)::int AS items_with_photos,
      coalesce(sum(jsonb_array_length(to_jsonb(i.photo_urls))), 0)::int AS photo_keys,
      count(*) FILTER (WHERE h.doc_no IS NULL)::int AS orphan_no_header,
      count(*) FILTER (WHERE i.company_id IS NULL)::int AS item_company_null,
      count(*) FILTER (WHERE h.company_id IS NULL)::int AS header_company_null,
      count(*) FILTER (WHERE h.doc_no IS NOT NULL
                         AND i.company_id IS NOT NULL
                         AND h.company_id IS NOT NULL
                         AND i.company_id <> h.company_id)::int AS mismatched,
      count(*) FILTER (WHERE h.doc_no IS NOT NULL
                         AND i.company_id IS NOT NULL
                         AND h.company_id IS NOT NULL
                         AND i.company_id = h.company_id)::int AS aligned
      FROM scm.mfg_sales_order_items i
      LEFT JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE i.photo_urls IS NOT NULL
       AND jsonb_array_length(to_jsonb(i.photo_urls)) > 0`;

  notice("-- SO item photos (the table the fix scopes) --");
  notice(`  items carrying photos : ${verdict.items_with_photos}`);
  notice(`  photo keys total      : ${verdict.photo_keys}`);
  notice(`  ALIGNED (stay visible): ${verdict.aligned}`);
  notice(`  mismatched item/header: ${verdict.mismatched}`);
  notice(`  item.company_id NULL  : ${verdict.item_company_null}`);
  notice(`  header.company_id NULL: ${verdict.header_company_null}`);
  notice(`  no header for doc_no  : ${verdict.orphan_no_header}`);

  /* -- 2. Per-company spread. A fix that "works" only because every row is
     company 1 has not actually been exercised by production. */
  const spread = await sql`
    SELECT i.company_id::int AS company_id,
           count(*)::int AS items,
           coalesce(sum(jsonb_array_length(to_jsonb(i.photo_urls))), 0)::int AS keys
      FROM scm.mfg_sales_order_items i
     WHERE i.photo_urls IS NOT NULL
       AND jsonb_array_length(to_jsonb(i.photo_urls)) > 0
     GROUP BY i.company_id ORDER BY i.company_id`;
  notice("-- SO photo rows per company --");
  for (const r of spread) {
    const code = companies.find((c) => Number(c.id) === r.company_id)?.code ?? "?";
    notice(`  company ${r.company_id} (${code}): ${r.items} items, ${r.keys} keys`);
  }

  /* -- 3. CONTROLS. These two photo routes ALREADY scope by company and are
     working in production today. Measuring them the same way calibrates the
     verdict above: whatever alignment they show is the alignment that is
     known-survivable, because users are living with it right now. */
  const [poCtl] = await sql`
    SELECT count(*)::int AS items,
           count(*) FILTER (WHERE p.company_id IS NOT NULL
                              AND i.company_id IS NOT NULL
                              AND i.company_id <> p.company_id)::int AS mismatched
      FROM scm.purchase_order_items i
      LEFT JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.photo_urls IS NOT NULL
       AND jsonb_array_length(to_jsonb(i.photo_urls)) > 0`;
  notice(`-- CONTROL purchase_order_items (already scoped, live): ${poCtl.items} items, ${poCtl.mismatched} mismatched`);

  try {
    const [coCtl] = await sql`
      SELECT count(*)::int AS items,
             count(*) FILTER (WHERE h.company_id IS NOT NULL
                                AND i.company_id IS NOT NULL
                                AND i.company_id <> h.company_id)::int AS mismatched
        FROM scm.consignment_sales_order_items i
        LEFT JOIN scm.consignment_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.photo_urls IS NOT NULL
         AND jsonb_array_length(to_jsonb(i.photo_urls)) > 0`;
    notice(`-- CONTROL consignment_sales_order_items (already scoped, live): ${coCtl.items} items, ${coCtl.mismatched} mismatched`);
  } catch (e) {
    warn(`consignment control skipped: ${e.message}`);
  }

  /* -- 4. A docNo that resolves to MORE THAN ONE header is its own hazard:
     the route matches the item by id and then compares doc_no, so a doc_no
     reused across companies would let a company-2 user's active scope meet a
     company-1 item. Count it explicitly rather than assuming uniqueness. */
  const [dupDoc] = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT doc_no FROM scm.mfg_sales_orders
       GROUP BY doc_no HAVING count(DISTINCT company_id) > 1) d`;
  notice(`-- doc_no values shared across companies: ${dupDoc.n}`);

  /* -- 5. Name the casualties. A count alone is not actionable; if the fix
     would hide something, the owner needs the doc_no to go look at it. */
  const unreachable = verdict.mismatched + verdict.item_company_null
    + verdict.header_company_null + verdict.orphan_no_header;
  if (unreachable > 0) {
    const rows = await sql`
      SELECT i.id, i.doc_no, i.item_code,
             i.company_id::int AS item_company,
             h.company_id::int AS header_company,
             jsonb_array_length(to_jsonb(i.photo_urls))::int AS keys
        FROM scm.mfg_sales_order_items i
        LEFT JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.photo_urls IS NOT NULL
         AND jsonb_array_length(to_jsonb(i.photo_urls)) > 0
         AND (h.doc_no IS NULL OR i.company_id IS NULL OR h.company_id IS NULL
              OR i.company_id <> h.company_id)
       ORDER BY i.doc_no LIMIT 200`;
    warn(`${unreachable} SO photo row(s) would NOT survive company scoping — DO NOT SHIP until these are explained:`);
    for (const r of rows) {
      warn(`  ${r.doc_no} item=${r.id} ${r.item_code ?? ""} item_co=${r.item_company} header_co=${r.header_company} keys=${r.keys}`);
    }
    notice("VERDICT: UNSAFE — report these rows rather than shipping a change that hides photos.");
    await sql.end();
    process.exit(1);
  }

  notice("VERDICT: SAFE — every existing SO photo key stays reachable by a user of the company that owns its order.");
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(2); });
