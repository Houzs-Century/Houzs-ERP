// Read-only check of the Purchase Order list export (GET
// /api/scm/mfg-purchase-orders/export/rows, 2026-09-15) against the live data.
//
// WHY. The export must hold EVERY line of every order the list's filter matches,
// across every page. The unit tests prove the paging against a fake; this runs
// the export's OWN server code — the list's filter + sort (po-list-read.ts) and
// attachPoLines, the functions GET /export/rows and the list page call — over
// the real database. The header read selects only what attachPoLines needs: the
// list's full select carries an FK-hinted embed the read-only stand-in cannot
// run, and the header shape is proven by the route tests and compares the lines it attaches with a direct SQL
// read of the same rows, line id by line id. There is no service login to call
// the Worker from Actions, so the transport is the repo's read-only PostgREST
// stand-in (lib/pgrest-shim.mjs, CLAUDE.md R88) over DATABASE_URL; any query
// shape the shim cannot run is reported as a GAP and the run says it proved
// nothing. The grid's column funnels are applied in the browser and are not
// part of this check.
//
// Per company, for the tab given in STATUS (a list bucket: all, open,
// outstanding, partial, received, cancelled, draft, on_hold):
//   * export PO count / line count vs SQL, and the exact Line ID sets.
// Then the AutoCount-listing facts the columns depend on (PROBE lines, one JSON
// object per outstanding line of a PO linked to AutoCount): the ERP's supplier
// code, supplier SKU, item description, binding description, and the AutoCount
// pull mirror's description where that table exists — so the owner's AutoCount
// file can be compared row by row outside this job.
//
// Strictly read-only: the session is set READ ONLY before the first query, and
// every statement is a SELECT. Exits 0 for every answer, MISMATCH included.
// Non-zero only for an unreachable database.
//
// RE-RUN: Actions -> "PO line export check (read-only)" -> Run workflow
//         (runs under tsx: npx tsx scripts/check-po-line-export.mjs)
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const STATUS = (process.env.STATUS || "all").trim();
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
/* Dates and timestamps come back as TEXT, the way PostgREST's JSON carries them
   to the Worker. postgres.js would otherwise hand the export's code a JS Date,
   which the app never receives. */
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const pg = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  types: { dateText: asText(1082), timestampText: asText(1114), timestamptzText: asText(1184) },
});

let mismatches = 0;
try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db, ro }] = await pg`SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro`;
  notice(`database: ${db}; session read-only: ${ro}; tab: ${STATUS}`);

  const { attachPoLines } = await import("../src/scm/lib/po-line-export.ts");
  const { filterPoList, orderPoList } = await import("../src/scm/lib/po-list-read.ts");
  const { pageWithTruncation } = await import("../src/scm/lib/outstanding-po-lines.ts");
  const buildPoExportRows = async (sbx, ctx, filters, validStatuses) => {
    const read = await pageWithTruncation((from, to) =>
      orderPoList(filterPoList(sbx.from("purchase_orders").select("id, po_number, purchase_location_id, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4"), filters, ctx, validStatuses), filters.sort)
        .range(from, to));
    if (read.error) return { error: read.error.message };
    const withLines = await attachPoLines(sbx, ctx, read.data ?? []);
    if (withLines.error) return { error: withLines.error };
    return { error: null, purchaseOrders: withLines.rows, lineCount: withLines.lineCount, truncated: read.truncated };
  };
  const { PO_STATUS_BUCKETS } = await import("../src/scm/lib/po-status-buckets.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(pg, "scm");
  const statuses = STATUS === "all" ? null : PO_STATUS_BUCKETS[STATUS];
  if (STATUS !== "all" && STATUS !== "on_hold" && !statuses) {
    notice(`STATUS "${STATUS}" is not a list tab; nothing checked.`);
  }

  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  for (const co of companies) {
    const ctx = { get: (k) => (k === "companyId" ? Number(co.id) : undefined) };
    const filters = { status: STATUS === "all" ? null : STATUS, supplierId: null, q: null, from: null, to: null, sort: null };
    const t0 = Date.now();
    const out = await buildPoExportRows(sb, ctx, filters, new Set());
    const ms = Date.now() - t0;
    if (sb.__gaps.length > 0) {
      notice(`GAP — the shim could not run the export's reads, so nothing below is proven: ${sb.__gaps.join(" | ")}`);
      mismatches += 1;
      break;
    }
    if (out.error !== null) {
      notice(`company ${co.code}: export returned error: ${out.error}`);
      mismatches += 1;
      continue;
    }
    const heldOnly = STATUS === "on_hold";
    const want = await pg`
      SELECT i.id::text AS id, p.id::text AS po
      FROM scm.purchase_orders p
      LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id AND i.company_id = ${co.id}
      WHERE p.company_id = ${co.id}
        AND (${statuses === null || heldOnly} OR p.status = ANY(${statuses ?? []}))
        AND (${!heldOnly} OR p.on_hold IS TRUE OR p.status = 'ON_HOLD')`;
    const wantPos = new Set(want.map((r) => r.po));
    const wantLines = new Set(want.filter((r) => r.id).map((r) => r.id));
    const gotLines = new Set(out.purchaseOrders.flatMap((r) => r.lines.map((l) => l.id)));
    const missing = [...wantLines].filter((id) => !gotLines.has(id));
    const extra = [...gotLines].filter((id) => !wantLines.has(id));
    const noLinePos = out.purchaseOrders.filter((r) => r.lines.length === 0).length;
    const ok = out.purchaseOrders.length === wantPos.size && out.lineCount === wantLines.size && missing.length === 0 && extra.length === 0;
    if (!ok) mismatches += 1;
    notice(
      `${ok ? "MATCH" : "MISMATCH"} company ${co.id} ${co.code} tab=${STATUS}: export ${out.purchaseOrders.length} POs / ${out.lineCount} lines ` +
        `(POs with no line ${noLinePos}; export file rows ${out.lineCount + noLinePos}; truncated=${out.truncated}, ${ms} ms); ` +
        `SQL ${wantPos.size} POs / ${wantLines.size} lines; missing ${missing.length}, extra ${extra.length}`,
    );
  }

  /* ── AutoCount listing facts ─────────────────────────────────────────── */
  const mirror = await pg`SELECT to_regclass('public.purchase_orders') IS NOT NULL AS has_mirror,
                                 to_regclass('public.ac_snapshot_purchase_orders') IS NOT NULL AS has_snapshot`;
  notice(`AutoCount pull mirror public.purchase_orders exists: ${mirror[0].has_mirror}; public.ac_snapshot_purchase_orders exists: ${mirror[0].has_snapshot}`);
  if (mirror[0].has_snapshot) {
    const cols = await pg`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ac_snapshot_purchase_orders' ORDER BY ordinal_position`;
    notice(`ac_snapshot_purchase_orders columns: ${cols.map((c) => c.column_name).join(", ")}`);
  }
  if (mirror[0].has_mirror) {
    const [m] = await pg`SELECT count(*)::int AS n, max(doc_date)::text AS newest FROM public.purchase_orders`;
    notice(`public.purchase_orders mirror rows ${m.n}, newest doc_date ${m.newest}`);
  }
  const probe = await pg.unsafe(`
    SELECT p.linked_ac_docno AS ac, p.po_number AS po, i.id::text AS lid, i.item_code AS ic, i.supplier_sku AS sku,
           i.material_name AS "desc", i.description2 AS d2, i.item_group AS grp, w.code AS wh, s.code AS cc, s.name AS cn,
           soi.doc_no AS so, (i.qty - COALESCE(i.received_qty, 0)) AS rem, p.po_date::text AS dt, i.delivery_date::text AS dd,
           COALESCE(i.supplier_delivery_date_2, p.supplier_delivery_date_2)::text AS e1,
           COALESCE(i.supplier_delivery_date_3, p.supplier_delivery_date_3)::text AS e2,
           COALESCE(i.supplier_delivery_date_4, p.supplier_delivery_date_4)::text AS e3,
           (SELECT b.material_name FROM scm.supplier_material_bindings b
             WHERE b.supplier_id = p.supplier_id AND b.item_code = i.item_code LIMIT 1) AS bdesc,
           (SELECT b.supplier_sku FROM scm.supplier_material_bindings b
             WHERE b.supplier_id = p.supplier_id AND b.item_code = i.item_code LIMIT 1) AS bsku
           ${mirror[0].has_mirror ? `, (SELECT m.item_description FROM public.purchase_orders m
             WHERE m.doc_no = p.linked_ac_docno AND m.item_code = i.supplier_sku LIMIT 1) AS mdesc` : ""}
    FROM scm.purchase_orders p
    JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id AND i.company_id = p.company_id
    LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
    LEFT JOIN scm.warehouses w ON w.id = COALESCE(i.warehouse_id, p.purchase_location_id)
    LEFT JOIN scm.mfg_sales_order_items soi ON soi.id = i.so_item_id AND soi.company_id = p.company_id
    WHERE p.linked_ac_docno IS NOT NULL AND p.status IN ('SUBMITTED', 'PARTIALLY_RECEIVED')
    ORDER BY p.linked_ac_docno, i.line_no NULLS FIRST, i.id`);
  notice(`PROBE rows (outstanding-status lines of POs linked to AutoCount): ${probe.length}`);
  /* Item Description 2 is exported as the variant summary, else the stored text
     (src/scm/lib/po-line-description2.ts). How many lines would print something
     other than their stored description2? */
  const { poLineDescription2 } = await import("../src/scm/lib/po-line-description2.ts");
  const d2rows = await pg`SELECT item_group, variants, description2 FROM scm.purchase_order_items`;
  let d2Differ = 0, d2FromVariants = 0, d2Fallback = 0;
  for (const r of d2rows) {
    const shown = poLineDescription2(r.item_group, r.variants, r.description2);
    const stored = (r.description2 ?? "").trim() || null;
    if (shown !== stored) d2Differ += 1;
    const summaryOnly = poLineDescription2(r.item_group, r.variants, null);
    if (summaryOnly) d2FromVariants += 1; else d2Fallback += 1;
  }
  notice(`Item Description 2 over ${d2rows.length} PO lines: from the variants ${d2FromVariants}, stored-text fallback ${d2Fallback}; exported text differs from the stored description2 on ${d2Differ}`);
  for (const r of probe) console.log(`PROBE ${JSON.stringify(r)}`);

  notice(mismatches === 0 ? "VERDICT: the export's server read returns exactly the lines a direct SQL read returns, per company." : `VERDICT: ${mismatches} MISMATCH / GAP / error line(s) above.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
