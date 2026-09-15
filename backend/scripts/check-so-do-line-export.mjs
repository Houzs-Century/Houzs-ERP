// Read-only check of the Sales Order and Delivery Order line exports
// (GET /api/scm/mfg-sales-orders/export/lines and
// /api/scm/delivery-orders-mfg/export/lines, 2026-09-15) against the live data.
//
// WHY. Each export must hold EVERY line of every document the list's tab and
// filters match, across every page. The unit tests prove the paging against a
// fake; this runs the exports' OWN code — buildSoLineExport / buildDoLineExport,
// the functions the routes call, through the list's own predicate builders
// (prepareSoListRead / filterDoList) — over the real database, and compares the
// answer with a direct SQL read of the same rows, line id by line id. There is
// no service login to call the Worker from Actions, so the transport is the
// repo's read-only PostgREST stand-in (lib/pgrest-shim.mjs, CLAUDE.md R88) over
// DATABASE_URL; any query shape the shim cannot run is reported as a GAP and the
// run says it proved nothing.
//
// Per company:
//   Sales Order    — the Submitted tab (status CONFIRMED); All with the
//                    second-level filter row orderDate:between (an `f` param);
//                    All.
//   Delivery Order — the Delivered tab (SIGNED + DELIVERED); the Confirmed tab
//                    (LOADED); All.
// Sales scope is the view-all tier (scopeIds null): the check compares against
// every row of the company, which only a view-all caller sees.
//
// Strictly read-only: the session is set READ ONLY before the first query, and
// the export code only SELECTs. Exits 0 for every answer, MISMATCH included —
// the answer is the output. Non-zero only for an unreachable database.
//
// RE-RUN: Actions -> "PO line export check (read-only)" -> document: so-do
//         (runs under tsx: npx tsx scripts/check-so-do-line-export.mjs)
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
/* Dates and timestamps come back as TEXT, the way PostgREST's JSON carries them
   to the Worker. */
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const pg = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  types: { dateText: asText(1082), timestampText: asText(1114), timestamptzText: asText(1184) },
});

/* The second-level filter row the SO check sends, and the SQL it must equal. */
const SO_MONTH = { from: "2026-08-01", to: "2026-08-31" };
const SO_F_ROW = `orderDate:between:${SO_MONTH.from}~${SO_MONTH.to}`;

const setOf = (rows) => new Set(rows.map((r) => r.id));

async function compare(label, co, out, want, headerCount, idCol, countKey, ms) {
  const got = new Set(out.rows.map((r) => String(r[idCol])));
  const missing = [...want].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !want.has(id));
  const ok = out[countKey] === headerCount && out.lineCount === want.size && got.size === out.rows.length && missing.length === 0 && extra.length === 0;
  notice(
    `${ok ? "MATCH" : "MISMATCH"} company ${co.id} ${co.code} ${label}: export ${out[countKey]} docs / ${out.lineCount} lines ` +
      `(truncated=${out.truncated}, ${ms} ms); SQL ${headerCount} docs / ${want.size} lines; ` +
      `line ids missing from export ${missing.length}, extra in export ${extra.length}`,
  );
  return ok;
}

let mismatches = 0;
try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db, ro }] = await pg`SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro`;
  notice(`database: ${db}; session read-only: ${ro}`);

  const { buildSoLineExport } = await import("../src/scm/lib/so-line-export.ts");
  const { prepareSoListRead } = await import("../src/scm/lib/so-list-read.ts");
  const { SO_LINE_EXPORT_COLUMNS } = await import("../src/scm/lib/so-line-export-columns.ts");
  const { buildDoLineExport } = await import("../src/scm/lib/do-line-export.ts");
  const { DO_LINE_EXPORT_COLUMNS } = await import("../src/scm/lib/do-line-export-columns.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(pg, "scm");
  const soId = SO_LINE_EXPORT_COLUMNS.indexOf("Line ID");
  const doId = DO_LINE_EXPORT_COLUMNS.indexOf("Line ID");

  const money = DO_LINE_EXPORT_COLUMNS.filter((c) => /price|amount|total|discount|balance|paid/i.test(c));
  notice(`Delivery Order export columns (${DO_LINE_EXPORT_COLUMNS.length}): money columns present: ${money.length === 0 ? "none" : money.join(", ")}`);
  if (money.length > 0) mismatches += 1;

  const gapStop = () => {
    if (sb.__gaps.length === 0) return false;
    notice(`GAP — the shim could not run the export's reads, so nothing below is proven: ${sb.__gaps.join(" | ")}`);
    mismatches += 1;
    return true;
  };

  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  outer: for (const co of companies) {
    const ctx = { get: (k) => (k === "companyId" ? Number(co.id) : undefined) };

    /* ── Sales Order ─────────────────────────────────────────────────────── */
    const soCases = [
      ["Submitted tab (status=CONFIRMED)", { status: "CONFIRMED", f: [] },
        pg`h.status = 'CONFIRMED'`],
      [`All + second-level filter f=${SO_F_ROW}`, { status: null, f: [SO_F_ROW] },
        pg`h.so_date BETWEEN ${SO_MONTH.from} AND ${SO_MONTH.to}`],
      ["All", { status: null, f: [] }, pg`TRUE`],
    ];
    for (const [label, p, pred] of soCases) {
      const params = { status: p.status, q: null, sort: null, from: null, to: null, f: p.f };
      const t0 = Date.now();
      const read = await prepareSoListRead(sb, ctx, params, null, null, new Date());
      if (!read.ok) { notice(`company ${co.code} SO ${label}: filter refused ${JSON.stringify(read.body)}`); mismatches += 1; continue; }
      const out = await buildSoLineExport(sb, ctx, read, null);
      const ms = Date.now() - t0;
      if (gapStop()) break outer;
      if (out.error !== null) { notice(`company ${co.code} SO ${label}: export returned error: ${out.error}`); mismatches += 1; continue; }
      const lines = await pg`SELECT i.id::text AS id FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
        WHERE h.company_id = ${co.id} AND ${pred}`;
      const [{ n }] = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders h WHERE h.company_id = ${co.id} AND ${pred}`;
      if (!(await compare(`SO ${label}`, co, out, setOf(lines), n, soId, "soCount", ms))) mismatches += 1;
      if (label === "All") {
        const col = (name) => SO_LINE_EXPORT_COLUMNS.indexOf(name);
        const words = new Map();
        for (const r of out.rows) words.set(r[col("Status")], (words.get(r[col("Status")]) ?? 0) + 1);
        notice(`company ${co.code} SO All — Status words over lines: ${[...words].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${w} ${k}`).join("; ")}`);
        const blankRemaining = out.rows.filter((r) => r[col("Remaining Qty")] === null).length;
        const locations = new Map();
        for (const r of out.rows) locations.set(r[col("Location")], (locations.get(r[col("Location")]) ?? 0) + 1);
        notice(`company ${co.code} SO All — lines with no Remaining Qty (not in the deliverable reading): ${blankRemaining}; Location values: ${[...locations].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${w} ${k}`).join("; ")}`);
      }
    }

    /* ── Delivery Order ──────────────────────────────────────────────────── */
    const doCases = [
      ["Delivered tab (status=delivered)", "delivered", pg`d.status IN ('SIGNED', 'DELIVERED')`],
      ["Confirmed tab (status=loaded)", "loaded", pg`d.status = 'LOADED'`],
      ["All", null, pg`TRUE`],
    ];
    for (const [label, status, pred] of doCases) {
      const params = { status, q: null, sort: null, from: null, to: null };
      const t0 = Date.now();
      const out = await buildDoLineExport(sb, ctx, params, null);
      const ms = Date.now() - t0;
      if (gapStop()) break outer;
      if (out.error !== null) { notice(`company ${co.code} DO ${label}: export returned error: ${out.error}`); mismatches += 1; continue; }
      const lines = await pg`SELECT i.id::text AS id FROM scm.delivery_order_items i
        JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
        WHERE d.company_id = ${co.id} AND i.company_id = ${co.id} AND ${pred}`;
      const [{ n }] = await pg`SELECT count(*)::int AS n FROM scm.delivery_orders d WHERE d.company_id = ${co.id} AND ${pred}`;
      if (!(await compare(`DO ${label}`, co, out, setOf(lines), n, doId, "doCount", ms))) mismatches += 1;
      if (label === "All") {
        const col = (name) => DO_LINE_EXPORT_COLUMNS.indexOf(name);
        const words = new Map();
        for (const r of out.rows) words.set(r[col("Status")], (words.get(r[col("Status")]) ?? 0) + 1);
        const blank = (name) => out.rows.filter((r) => r[col(name)] === null).length;
        notice(`company ${co.code} DO All — Status words over lines: ${[...words].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${w} ${k}`).join("; ")}`);
        notice(`company ${co.code} DO All — blank cells over ${out.rows.length} lines: Driver ${blank("Driver")}, Vehicle ${blank("Vehicle")}, Uninvoiced Qty ${blank("Uninvoiced Qty")}, Location ${blank("Location")}, SO Doc No. ${blank("SO Doc No.")}`);
      }
    }
  }

  const [cross] = await pg`
    SELECT (SELECT count(*)::int FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE i.company_id <> h.company_id) AS so_cross,
           (SELECT count(*)::int FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id WHERE i.company_id <> d.company_id) AS do_cross`;
  notice(`lines whose company differs from their document's (left out by the line read's company predicate): SO ${cross.so_cross}, DO ${cross.do_cross}`);

  notice(mismatches === 0
    ? "VERDICT: each export's own code returns exactly the lines a direct SQL read returns, per company, for every filter above."
    : `VERDICT: ${mismatches} MISMATCH / GAP / error line(s) above.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
