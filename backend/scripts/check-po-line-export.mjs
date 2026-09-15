// Read-only check of the Purchase Order line export (GET
// /api/scm/mfg-purchase-orders/export/lines, 2026-09-15) against the live data.
//
// WHY. The export must hold EVERY line of every order the list's tab matches,
// across every page. The unit tests prove the paging against a fake; this runs
// the export's OWN code — buildPoLineExport, the same function the route calls —
// over the real database and compares its answer with a direct SQL count of the
// same rows. There is no service login to call the Worker from Actions, so the
// transport is the repo's read-only PostgREST stand-in (lib/pgrest-shim.mjs,
// CLAUDE.md R88) over DATABASE_URL; any query shape the shim cannot run is
// reported as a GAP and the run says it proved nothing.
//
// Per company, for the "open" tab (the SUBMITTED bucket) and for All:
//   * export poCount / lineCount vs SQL counts, and the exact Line ID sets;
// plus the facts the column rules depend on: how many lines carry an estimate
// date that DIFFERS from their PO header's (the line wins), the money column
// types, and the three POs the owner compared (HC-PO-009949/50/51).
//
// Strictly read-only: the session is set READ ONLY before the first query, and
// the export code only SELECTs. Exits 0 for every answer, MISMATCH included —
// the answer is the output. Non-zero only for an unreachable database.
//
// RE-RUN: Actions -> "PO line export check (read-only)" -> Run workflow
//         (runs under tsx: npx tsx scripts/check-po-line-export.mjs)
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
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

/* The "open" tab is the SUBMITTED bucket (backend/src/scm/lib/po-status-buckets.ts). */
const OPEN = ["SUBMITTED"];

async function sqlLineIds(companyId, statuses) {
  const rows = statuses
    ? await pg`SELECT i.id::text AS id, p.id::text AS po FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
               WHERE p.company_id = ${companyId} AND i.company_id = ${companyId} AND p.status = ANY(${statuses})`
    : await pg`SELECT i.id::text AS id, p.id::text AS po FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
               WHERE p.company_id = ${companyId} AND i.company_id = ${companyId}`;
  const [po] = statuses
    ? await pg`SELECT count(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${companyId} AND status = ANY(${statuses})`
    : await pg`SELECT count(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${companyId}`;
  return { ids: new Set(rows.map((r) => r.id)), pos: po.n };
}

let mismatches = 0;
try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db, ro }] = await pg`SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro`;
  notice(`database: ${db}; session read-only: ${ro}`);

  const { buildPoLineExport } = await import("../src/scm/lib/po-line-export.ts");
  const { PO_LINE_EXPORT_COLUMNS } = await import("../src/scm/lib/po-line-export-columns.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(pg, "scm");
  const lineIdCol = PO_LINE_EXPORT_COLUMNS.indexOf("Line ID");

  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  for (const co of companies) {
    const ctx = { get: (k) => (k === "companyId" ? Number(co.id) : undefined) };
    for (const [label, statusParam, statuses] of [["open tab", "open", OPEN], ["All", null, null]]) {
      const filters = { status: statusParam, supplierId: null, q: null, from: null, to: null, sort: null };
      const t0 = Date.now();
      /* validStatuses is consulted only for a RAW status; a tab sends its bucket
         name, so an empty set changes nothing here. */
      const out = await buildPoLineExport(sb, ctx, filters, new Set());
      const ms = Date.now() - t0;
      if (sb.__gaps.length > 0) {
        notice(`GAP — the shim could not run the export's reads, so nothing below is proven: ${sb.__gaps.join(" | ")}`);
        mismatches += 1;
        break;
      }
      if (out.error !== null) {
        notice(`company ${co.code} ${label}: export returned error: ${out.error}`);
        mismatches += 1;
        continue;
      }
      const want = await sqlLineIds(co.id, statuses);
      const got = new Set(out.rows.map((r) => String(r[lineIdCol])));
      const missing = [...want.ids].filter((id) => !got.has(id));
      const extra = [...got].filter((id) => !want.ids.has(id));
      const ok = out.poCount === want.pos && out.lineCount === want.ids.size && got.size === out.rows.length && missing.length === 0 && extra.length === 0;
      if (!ok) mismatches += 1;
      notice(
        `${ok ? "MATCH" : "MISMATCH"} company ${co.id} ${co.code} ${label}: export ${out.poCount} POs / ${out.lineCount} lines ` +
          `(truncated=${out.truncated}, ${ms} ms); SQL ${want.pos} POs / ${want.ids.size} lines; ` +
          `line ids missing from export ${missing.length}, extra in export ${extra.length}`,
      );
    }
  }

  const types = await pg`
    SELECT column_name, data_type, numeric_scale FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'purchase_order_items'
      AND column_name IN ('qty', 'received_qty', 'unit_price_sen', 'line_total_sen')
    ORDER BY column_name`;
  for (const t of types) notice(`type purchase_order_items.${t.column_name}: ${t.data_type}${t.numeric_scale != null ? ` scale ${t.numeric_scale}` : ""}`);

  for (const slot of [2, 3, 4]) {
    const col = `supplier_delivery_date_${slot}`;
    const [r] = await pg.unsafe(`
      SELECT count(*)::int                                                                    AS lines,
             count(*) FILTER (WHERE i.${col} IS NOT NULL)::int                                AS line_set,
             count(*) FILTER (WHERE p.${col} IS NOT NULL)::int                                AS header_set,
             count(*) FILTER (WHERE i.${col} IS NOT NULL AND p.${col} IS NOT NULL
                               AND i.${col} <> p.${col})::int                                 AS both_differ,
             count(*) FILTER (WHERE i.${col} IS NULL AND p.${col} IS NOT NULL)::int           AS header_fills_blank_line
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id`);
    notice(
      `${col} = Estimate Delivery Date ${slot - 1}, over ${r.lines} lines: line set ${r.line_set}; header set ${r.header_set}; ` +
        `both set and DIFFERENT ${r.both_differ} (the export prints the line's); header fills a blank line ${r.header_fills_blank_line}`,
    );
  }

  const [cross] = await pg`
    SELECT count(*)::int AS n FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE i.company_id <> p.company_id`;
  notice(`lines whose company differs from their PO's (left out by the line read's company predicate): ${cross.n}`);

  const sample = await pg`
    SELECT p.po_number, i.item_code, i.delivery_date::text AS dd,
           i.supplier_delivery_date_2::text AS l2, i.supplier_delivery_date_3::text AS l3, i.supplier_delivery_date_4::text AS l4,
           p.supplier_delivery_date_2::text AS h2, p.supplier_delivery_date_3::text AS h3, p.supplier_delivery_date_4::text AS h4
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.po_number IN ('HC-PO-009949', 'HC-PO-009950', 'HC-PO-009951')
    ORDER BY p.po_number, i.line_no NULLS FIRST, i.id`;
  for (const s of sample) {
    notice(`${s.po_number} ${s.item_code}: delivery ${s.dd}; line estimates ${s.l2}/${s.l3}/${s.l4}; header estimates ${s.h2}/${s.h3}/${s.h4}`);
  }

  notice(mismatches === 0 ? "VERDICT: the export's own code returns exactly the lines a direct SQL read returns, per company, for both tabs." : `VERDICT: ${mismatches} MISMATCH / GAP / error line(s) above.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
