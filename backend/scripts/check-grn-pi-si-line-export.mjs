// Read-only check of the Goods Received, Purchase Invoice and Sales Invoice
// exports (GET /api/scm/grns/export/rows, /purchase-invoices/export/rows,
// /sales-invoices/export/rows, 2026-09-15) against the live data.
//
// WHY. Each export must hold EVERY line of every document the list's filter
// matches, across every page. The unit tests prove the paging against a fake;
// this runs each export's OWN code — readGrnExportRows / readPiExportRows /
// readSiExportRows, the functions the routes call — over the real database and
// compares the answer with a direct SQL read of the same rows, LINE ID BY LINE
// ID. There is no service login to call the Worker from Actions, so the
// transport is the repo's read-only PostgREST stand-in (lib/pgrest-shim.mjs,
// CLAUDE.md R88) over DATABASE_URL; a query shape the shim cannot run is a GAP
// and the run says it proved nothing. (The search box is not exercised: its
// `ilike` disjunction is outside the shim's grammar. The unit tests cover it.)
//
// Per company, per document: one tab, All, and a received/invoice date window;
// for Sales Invoices also a single-seller SALES SCOPE. Then the facts the
// column rules rest on: GR Invoiced Qty (the ERP's sum) against the stored
// migrated figure, the AutoCount GR number column, and how many lines carry a
// DO / GRN link.
//
// Strictly read-only: the session is set READ ONLY before the first query and
// the export code only SELECTs. Exits 0 for every answer, MISMATCH included —
// the answer is the output. Non-zero only for an unreachable database.
//
// RE-RUN: Actions -> "GRN / PI / SI line export check (read-only)" -> Run workflow
//         (runs under tsx: npx tsx scripts/check-grn-pi-si-line-export.mjs)
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

const ymd = (d) => d.toISOString().slice(0, 10);
const TODAY = ymd(new Date(Date.now() + 8 * 3600 * 1000));
const WINDOW_FROM = ymd(new Date(Date.now() + 8 * 3600 * 1000 - 45 * 86400 * 1000));

let mismatches = 0;

function compare(label, out, countKey, want, lineIdCol) {
  const got = new Set(out.rows.map((r) => String(r[lineIdCol])));
  const missing = [...want.ids].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !want.ids.has(id));
  const ok = out[countKey] === want.docs && out.lineCount === want.ids.size && got.size === out.rows.length
    && missing.length === 0 && extra.length === 0 && out.truncated === false;
  if (!ok) mismatches += 1;
  notice(
    `${ok ? "MATCH" : "MISMATCH"} ${label}: export ${out[countKey]} docs / ${out.lineCount} lines (truncated=${out.truncated}); ` +
      `SQL ${want.docs} docs / ${want.ids.size} lines; line ids missing from export ${missing.length}, extra in export ${extra.length}` +
      (missing.length ? `; first missing ${missing.slice(0, 3).join(",")}` : "") +
      (extra.length ? `; first extra ${extra.slice(0, 3).join(",")}` : ""),
  );
  return ok;
}

/* SQL reads of the same population. `where` is a fragment over header alias h. */
async function sqlSet(headerTable, lineTable, fk, companyId, where, params) {
  const docs = await pg.unsafe(
    `SELECT count(*)::int AS n FROM scm.${headerTable} h WHERE h.company_id = $1 ${where}`, [companyId, ...params]);
  const lines = await pg.unsafe(
    `SELECT i.id::text AS id FROM scm.${lineTable} i JOIN scm.${headerTable} h ON h.id = i.${fk}
     WHERE h.company_id = $1 AND i.company_id = $1 ${where}`, [companyId, ...params]);
  return { docs: docs[0].n, ids: new Set(lines.map((r) => r.id)) };
}

async function run(sb, label, fn) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  if (sb.__gaps.length > 0) {
    notice(`GAP — ${label}: the shim could not run the export's reads, so nothing below is proven: ${sb.__gaps.join(" | ")}`);
    sb.__gaps.length = 0;
    mismatches += 1;
    return null;
  }
  if (out.error !== null) {
    notice(`ERROR ${label}: export returned error: ${out.error}`);
    mismatches += 1;
    return null;
  }
  notice(`${label}: ran in ${ms} ms`);
  return out;
}

try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db, ro }] = await pg`SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro`;
  notice(`database: ${db}; session read-only: ${ro}; today (MYT) ${TODAY}; date window from ${WINDOW_FROM}`);

  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const { GRN_STATUS_BUCKETS } = await import("../src/scm/lib/grn-status-buckets.ts");
  const { PI_STATUS_BUCKETS } = await import("../src/scm/lib/pi-status-buckets.ts");
  const { SI_STATUS_BUCKETS } = await import("../src/scm/lib/si-status-buckets.ts");
  const { readGrnExportRows } = await import("../src/scm/lib/grn-export-rows.ts");
  const { readPiExportRows } = await import("../src/scm/lib/pi-export-rows.ts");
  const { readSiExportRows } = await import("../src/scm/lib/si-export-rows.ts");
  const sb = pgrestShim(pg, "scm");
  /* compare() reads a Line ID per row: flatten each reader's documents to one
     row per line. */
  const asRows = (out, countKey) => (out.error !== null ? out : {
    error: null, [countKey]: out.rows.length, lineCount: out.lineCount, truncated: out.truncated,
    rows: out.rows.flatMap((d) => d.lines.map((l) => [l.id])), docs: out.rows,
  });
  const linesOf = (out) => out.docs.flatMap((d) => d.lines.map((l) => ({ ...l, doc: d })));

  const noFilter = { status: null, supplierId: null, q: null, from: null, to: null, sort: null };
  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;

  for (const co of companies) {
    const cid = Number(co.id);
    const ctx = { get: (k) => (k === "companyId" ? cid : undefined) };
    const tag = `company ${cid} ${co.code}`;

    /* ── Goods Received ─────────────────────────────────────────────────── */
    for (const [name, filters, where, params] of [
      ["posted tab", { ...noFilter, status: "posted" }, "AND h.status::text = ANY($2::text[])", [GRN_STATUS_BUCKETS.posted]],
      ["All", noFilter, "", []],
      [`received ${WINDOW_FROM}..${TODAY}`, { ...noFilter, from: WINDOW_FROM, to: TODAY }, "AND h.received_at >= $2 AND h.received_at <= $3", [WINDOW_FROM, TODAY]],
    ]) {
      const out = await run(sb, `GRN ${tag} ${name}`, async () => asRows(await readGrnExportRows(sb, ctx, filters), "grnCount"));
      if (!out) continue;
      const want = await sqlSet("grns", "grn_items", "grn_id", cid, where, params);
      compare(`GRN /export/rows ${tag} ${name}`, out, "grnCount", want, 0);
      if (name !== "All") continue;
      const sums = await pg`
        SELECT gi.id::text AS id, coalesce(sum(pii.qty) FILTER (WHERE p.status::text NOT IN ('DRAFT','CANCELLED') AND p.company_id = ${cid} AND pii.company_id = ${cid}), 0)::numeric AS q,
               gi.invoiced_qty::numeric AS stored
        FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
        LEFT JOIN scm.purchase_invoice_items pii ON pii.grn_item_id = gi.id
        LEFT JOIN scm.purchase_invoices p ON p.id = pii.purchase_invoice_id
        WHERE g.company_id = ${cid} AND gi.company_id = ${cid}
        GROUP BY gi.id, gi.invoiced_qty`;
      const byId = new Map(sums.map((r) => [r.id, r]));
      const lines = linesOf(out);
      let qtyDiff = 0, storedDiffers = 0;
      for (const l of lines) {
        const sq = byId.get(String(l.id));
        if (!sq) continue;
        if (Number(l.invoiced_qty) !== Number(sq.q)) qtyDiff += 1;
        if (Number(sq.stored) !== Number(sq.q)) storedDiffers += 1;
      }
      if (qtyDiff > 0) mismatches += 1;
      notice(`${qtyDiff === 0 ? "MATCH" : "MISMATCH"} GRN ${tag} Invoiced Qty = SQL sum of live invoice lines on ${lines.length - qtyDiff} / ${lines.length} lines; the stored grn_items.invoiced_qty differs from that sum on ${storedDiffers} lines (the export prints the sum)`);
      const acPo = out.docs.filter((d) => String(d.ac_doc_no ?? "").startsWith("PO-")).length;
      if (acPo > 0) mismatches += 1;
      notice(`${acPo === 0 ? "MATCH" : "MISMATCH"} GRN ${tag} AutoCount Doc No holding a PO number: ${acPo} receipts; with no AutoCount number: ${out.docs.filter((d) => !d.ac_doc_no).length} / ${out.docs.length}`);
    }

    /* ── Purchase Invoices ──────────────────────────────────────────────── */
    for (const [name, filters, where, params] of [
      ["posted tab", { ...noFilter, status: "posted" }, "AND h.status::text = ANY($2::text[])", [PI_STATUS_BUCKETS.posted]],
      ["All", noFilter, "", []],
      [`invoiced ${WINDOW_FROM}..${TODAY}`, { ...noFilter, from: WINDOW_FROM, to: TODAY }, "AND h.invoice_date >= $2 AND h.invoice_date <= $3", [WINDOW_FROM, TODAY]],
    ]) {
      const out = await run(sb, `PI ${tag} ${name}`, async () => asRows(await readPiExportRows(sb, ctx, filters), "piCount"));
      if (!out) continue;
      const want = await sqlSet("purchase_invoices", "purchase_invoice_items", "purchase_invoice_id", cid, where, params);
      compare(`PI /export/rows ${tag} ${name}`, out, "piCount", want, 0);
      if (name !== "All") continue;
      const [link] = await pg`
        SELECT count(*) FILTER (WHERE g.id IS NOT NULL)::int AS grn
        FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
        LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id AND gi.company_id = ${cid}
        LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${cid}
        WHERE h.company_id = ${cid} AND i.company_id = ${cid}`;
      const exported = linesOf(out).filter((l) => l.grn_no !== null).length;
      if (exported !== link.grn) mismatches += 1;
      notice(`${exported === link.grn ? "MATCH" : "MISMATCH"} PI ${tag} lines with a GRN No.: export ${exported}, SQL ${link.grn}, of ${linesOf(out).length}`);
    }

    /* ── Sales Invoices ─────────────────────────────────────────────────── */
    const [seller] = await pg`
      SELECT salesperson_id::text AS id, count(*)::int AS n FROM scm.sales_invoices
      WHERE company_id = ${cid} AND salesperson_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1`;
    const siCases = [
      ["sent tab", { ...noFilter, status: "sent" }, null, "AND h.status::text = ANY($2::text[])", [SI_STATUS_BUCKETS.sent]],
      ["All", noFilter, null, "", []],
      [`invoiced ${WINDOW_FROM}..${TODAY}`, { ...noFilter, from: WINDOW_FROM, to: TODAY }, null, "AND h.invoice_date >= $2 AND h.invoice_date <= $3", [WINDOW_FROM, TODAY]],
    ];
    if (seller) siCases.push([`one seller's scope (${seller.n} invoices)`, noFilter, [seller.id], "AND h.salesperson_id = ANY($2::uuid[])", [[seller.id]]]);
    for (const [name, filters, scopeIds, where, params] of siCases) {
      const out = await run(sb, `SI ${tag} ${name}`, async () => asRows(await readSiExportRows(sb, ctx, filters, scopeIds), "siCount"));
      if (!out) continue;
      const want = await sqlSet("sales_invoices", "sales_invoice_items", "sales_invoice_id", cid, where, params);
      compare(`SI /export/rows ${tag} ${name}`, out, "siCount", want, 0);
      if (name !== "All") continue;
      const [link] = await pg`
        SELECT count(*) FILTER (WHERE d.id IS NOT NULL)::int AS dos, count(*) FILTER (WHERE i.so_item_id IS NOT NULL)::int AS so_link
        FROM scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
        LEFT JOIN scm.delivery_order_items di ON di.id = i.do_item_id AND di.company_id = ${cid}
        LEFT JOIN scm.delivery_orders d ON d.id = di.delivery_order_id AND d.company_id = ${cid}
        WHERE h.company_id = ${cid} AND i.company_id = ${cid}`;
      const exported = linesOf(out).filter((l) => l.do_no !== null).length;
      if (exported !== link.dos) mismatches += 1;
      notice(`${exported === link.dos ? "MATCH" : "MISMATCH"} SI ${tag} lines with a DO No. (through the DO line): export ${exported}, SQL ${link.dos}, of ${linesOf(out).length}; lines whose own so_item_id is set: ${link.so_link}`);
    }
  }

  notice(mismatches === 0
    ? "VERDICT: every export's own code returns exactly the lines a direct SQL read returns, per company, for every filter above."
    : `VERDICT: ${mismatches} MISMATCH / GAP / error line(s) above.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
