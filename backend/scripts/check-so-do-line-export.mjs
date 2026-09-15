// Read-only check of the Sales Order and Delivery Order list exports
// (GET /api/scm/mfg-sales-orders/export/rows and
// /api/scm/delivery-orders-mfg/export/rows, 2026-09-15) against the live data.
//
// WHY. Each export must hold EVERY line of every document the list's tab and
// filters match, across every page. The unit tests prove the paging against a
// fake; this runs the exports' OWN code — buildSoExportRows / buildDoExportRows,
// the functions the routes call, through the list's own predicate builders
// (prepareSoListRead / filterDoList) and the list page's own row builders — over
// the real database, and compares the answer with a direct SQL read of the same
// rows, line id by line id. There is no service login to call the Worker from
// Actions, so the transport is the repo's read-only PostgREST stand-in
// (lib/pgrest-shim.mjs, CLAUDE.md R88) over DATABASE_URL; any query shape the
// shim cannot run is reported as a GAP and the run says it proved nothing.
//
// The export is served in WINDOWS (?offset=, at most EXPORT_WINDOW documents per
// request); this reads every window, as the browser does. It also COUNTS the
// PostgREST requests each window makes. On the Worker each one is a subrequest,
// and a Worker invocation has a subrequest cap (SUBREQUEST_CAP below —
// Cloudflare's paid-plan figure as this file was written; a window over it would
// fail in production however right its rows).
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
const SUBREQUEST_CAP = 1000;
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

/* Every window of one export, as the browser reads it: until next is null. */
async function allWindows(run, key) {
  const rows = [];
  let lineCount = 0, windows = 0, maxRequests = 0, ms = 0;
  for (let offset = 0; offset !== null;) {
    const t0 = Date.now();
    const { out, requests } = await run({ offset, limit: 500 });
    ms += Date.now() - t0;
    if (out.error !== null) return { error: out.error };
    rows.push(...out[key]);
    lineCount += out.lineCount;
    windows += 1;
    maxRequests = Math.max(maxRequests, requests);
    if (out.next !== null && out.next <= offset) return { error: "next did not advance" };
    offset = out.next;
  }
  return { error: null, rows, total: new Set(rows.map((r) => r.id ?? r.doc_no)).size, lineCount, windows, maxRequests, ms };
}

async function compare(label, co, out, want, headerCount) {
  const { ms, maxRequests: requests } = out;
  const got = new Set(out.rows.flatMap((r) => (r.lines ?? []).map((l) => String(l.id))));
  const missing = [...want].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !want.has(id));
  const ok = out.total === headerCount && out.lineCount === want.size && missing.length === 0 && extra.length === 0 && requests <= SUBREQUEST_CAP;
  notice(
    `${ok ? "MATCH" : "MISMATCH"} company ${co.id} ${co.code} ${label}: export ${out.total} docs / ${out.lineCount} lines ` +
      `(${out.windows} windows, ${ms} ms, at most ${requests} PostgREST requests per window of a ${SUBREQUEST_CAP} cap); SQL ${headerCount} docs / ${want.size} lines; ` +
      `line ids missing from export ${missing.length}, extra in export ${extra.length}`,
  );
  return ok;
}

let mismatches = 0;
try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db, ro }] = await pg`SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro`;
  notice(`database: ${db}; session read-only: ${ro}`);

  const { buildSoExportRows } = await import("../src/scm/lib/so-list-lines.ts");
  const { prepareSoListRead } = await import("../src/scm/lib/so-list-read.ts");
  const { buildDoExportRows } = await import("../src/scm/lib/do-list-lines.ts");
  const { SO_LIST_COLS } = await import("../src/scm/routes/mfg-sales-orders.ts");
  const { DO_LIST_HEADER, DO_LIST_ROW_DEPS } = await import("../src/scm/routes/delivery-orders-mfg.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const shim = pgrestShim(pg, "scm");
  let requests = 0;
  const sb = new Proxy(shim, {
    get(target, prop) {
      const v = target[prop];
      if ((prop === "from" || prop === "rpc") && typeof v === "function") return (...a) => { requests += 1; return v.apply(target, a); };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const gapStop = () => {
    if (shim.__gaps.length === 0) return false;
    notice(`GAP — the shim could not run the export's reads, so nothing below is proven: ${shim.__gaps.join(" | ")}`);
    mismatches += 1;
    return true;
  };

  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  outer: for (const co of companies) {
    /* A view-all caller with no finance view: the export's reads, not its money. */
    const ctx = { get: (k) => (k === "companyId" ? Number(co.id) : k === "supabase" ? sb : undefined), env: {}, req: { query: () => undefined } };

    /* ── Sales Order ─────────────────────────────────────────────────────── */
    const soCases = [
      ["Submitted tab (status=CONFIRMED)", { status: "CONFIRMED", f: [] }, pg`h.status = 'CONFIRMED'`],
      [`All + second-level filter f=${SO_F_ROW}`, { status: null, f: [SO_F_ROW] }, pg`h.so_date BETWEEN ${SO_MONTH.from} AND ${SO_MONTH.to}`],
      ["All", { status: null, f: [] }, pg`TRUE`],
    ];
    for (const [label, p, pred] of soCases) {
      const params = { status: p.status, q: null, sort: null, from: null, to: null, f: p.f };
      const read = await prepareSoListRead(sb, ctx, params, null, null, new Date());
      if (!read.ok) { notice(`company ${co.code} SO ${label}: filter refused ${JSON.stringify(read.body)}`); mismatches += 1; continue; }
      const out = await allWindows(async (w) => { requests = 0; const o = await buildSoExportRows(sb, ctx, read, null, SO_LIST_COLS, w); return { out: o, requests }; }, "salesOrders");
      if (gapStop()) break outer;
      if (out.error !== null) { notice(`company ${co.code} SO ${label}: export returned error: ${out.error}`); mismatches += 1; continue; }
      const lines = await pg`SELECT i.id::text AS id FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
        WHERE h.company_id = ${co.id} AND ${pred}`;
      const [{ n }] = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders h WHERE h.company_id = ${co.id} AND ${pred}`;
      if (!(await compare(`SO ${label}`, co, out, new Set(lines.map((r) => r.id)), n))) mismatches += 1;
      if (label === "All") {
        const all = out.rows.flatMap((r) => r.lines);
        const count = (pick) => { const m = new Map(); for (const l of all) m.set(pick(l), (m.get(pick(l)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, k]) => `${w} ${k}`).join("; "); };
        notice(`company ${co.code} SO All — Item Group over lines: ${count((l) => l.item_group)}`);
        notice(`company ${co.code} SO All — Location over lines: ${count((l) => l.location)}; lines with no Remaining Qty: ${all.filter((l) => l.remaining_qty === null).length}`);
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
      const out = await allWindows(async (w) => { requests = 0; const o = await buildDoExportRows(sb, ctx, params, null, DO_LIST_HEADER, DO_LIST_ROW_DEPS, w); return { out: o, requests }; }, "deliveryOrders");
      if (gapStop()) break outer;
      if (out.error !== null) { notice(`company ${co.code} DO ${label}: export returned error: ${out.error}`); mismatches += 1; continue; }
      const lines = await pg`SELECT i.id::text AS id FROM scm.delivery_order_items i
        JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
        WHERE d.company_id = ${co.id} AND i.company_id = ${co.id} AND ${pred}`;
      const [{ n }] = await pg`SELECT count(*)::int AS n FROM scm.delivery_orders d WHERE d.company_id = ${co.id} AND ${pred}`;
      if (!(await compare(`DO ${label}`, co, out, new Set(lines.map((r) => r.id)), n))) mismatches += 1;
      if (label === "All") {
        const all = out.rows.flatMap((r) => r.lines);
        const money = all.filter((l) => Object.keys(l).some((k) => /price|total|amount|discount|sen/i.test(k))).length;
        notice(`company ${co.code} DO All — lines carrying a money field: ${money}; blank Uninvoiced Qty ${all.filter((l) => l.uninvoiced_qty === null).length}, blank Location ${all.filter((l) => l.location === null).length}, blank SO Doc No. ${all.filter((l) => l.so_doc_no === null).length} of ${all.length}`);
        if (money > 0) mismatches += 1;
      }
    }
  }

  const [cross] = await pg`
    SELECT (SELECT count(*)::int FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE i.company_id <> h.company_id) AS so_cross,
           (SELECT count(*)::int FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id WHERE i.company_id <> d.company_id) AS do_cross`;
  notice(`lines whose company differs from their document's (left out by the line read's company predicate): SO ${cross.so_cross}, DO ${cross.do_cross}`);

  notice(mismatches === 0
    ? `VERDICT: each export's own code returns exactly the lines a direct SQL read returns, per company, for every filter above, within ${SUBREQUEST_CAP} requests per window.`
    : `VERDICT: ${mismatches} MISMATCH / GAP / error line(s) above.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
