// Read-only check of the Goods Received, Purchase Invoice and Sales Invoice
// LINE exports (GET /api/scm/grns/export/lines, /purchase-invoices/export/lines,
// /sales-invoices/export/lines, 2026-09-15) against the live data.
//
// WHY. Each export must hold EVERY line of every document the list's filter
// matches, across every page. The unit tests prove the paging against a fake;
// this runs each export's OWN code — buildGrnLineExport / buildPiLineExport /
// buildSiLineExport, the functions the routes call — over the real database and
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
// migrated figure, the AutoCount GR number column, how many lines carry a DO /
// GRN link, and how many due dates are blank.
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
  const { buildGrnLineExport } = await import("../src/scm/lib/grn-line-export.ts");
  const { GRN_LINE_EXPORT_COLUMNS } = await import("../src/scm/lib/grn-line-export-columns.ts");
  const { GRN_STATUS_BUCKETS } = await import("../src/scm/lib/grn-status-buckets.ts");
  const { buildPiLineExport } = await import("../src/scm/lib/pi-line-export.ts");
  const { PI_LINE_EXPORT_COLUMNS } = await import("../src/scm/lib/pi-line-export-columns.ts");
  const { PI_STATUS_BUCKETS } = await import("../src/scm/lib/pi-status-buckets.ts");
  const { buildSiLineExport } = await import("../src/scm/lib/si-line-export.ts");
  const { SI_LINE_EXPORT_COLUMNS } = await import("../src/scm/lib/si-line-export-columns.ts");
  const { SI_STATUS_BUCKETS } = await import("../src/scm/lib/si-status-buckets.ts");
  const sb = pgrestShim(pg, "scm");

  const noFilter = { status: null, supplierId: null, q: null, from: null, to: null, sort: null };
  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;

  for (const co of companies) {
    const cid = Number(co.id);
    const ctx = { get: (k) => (k === "companyId" ? cid : undefined) };
    const tag = `company ${cid} ${co.code}`;

    /* ── Goods Received ─────────────────────────────────────────────────── */
    {
      const lineId = GRN_LINE_EXPORT_COLUMNS.indexOf("Line ID");
      const cases = [
        ["posted tab", { ...noFilter, status: "posted" }, "AND h.status::text = ANY($2::text[])", [GRN_STATUS_BUCKETS.posted]],
        ["All", noFilter, "", []],
        [`received ${WINDOW_FROM}..${TODAY}`, { ...noFilter, from: WINDOW_FROM, to: TODAY }, "AND h.received_at >= $2 AND h.received_at <= $3", [WINDOW_FROM, TODAY]],
      ];
      for (const [name, filters, where, params] of cases) {
        const out = await run(sb, `GRN ${tag} ${name}`, () => buildGrnLineExport(sb, ctx, filters));
        if (!out) continue;
        const want = await sqlSet("grns", "grn_items", "grn_id", cid, where, params);
        compare(`GRN ${tag} ${name}`, out, "grnCount", want, lineId);

        if (name === "All") {
          const col = (n) => GRN_LINE_EXPORT_COLUMNS.indexOf(n);
          /* Invoiced Qty, line by line, against the ERP's own sum in SQL. */
          const sums = await pg`
            SELECT gi.id::text AS id, coalesce(sum(pii.qty) FILTER (WHERE p.status::text NOT IN ('DRAFT','CANCELLED') AND p.company_id = ${cid} AND pii.company_id = ${cid}), 0)::numeric AS q,
                   gi.invoiced_qty::numeric AS stored
            FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
            LEFT JOIN scm.purchase_invoice_items pii ON pii.grn_item_id = gi.id
            LEFT JOIN scm.purchase_invoices p ON p.id = pii.purchase_invoice_id
            WHERE g.company_id = ${cid} AND gi.company_id = ${cid}
            GROUP BY gi.id, gi.invoiced_qty`;
          const byId = new Map(sums.map((r) => [r.id, r]));
          let qtyDiff = 0, storedDiffers = 0;
          for (const r of out.rows) {
            const s = byId.get(String(r[lineId]));
            if (!s) continue;
            if (Number(r[col("Invoiced Qty")]) !== Number(s.q)) qtyDiff += 1;
            if (Number(s.stored) !== Number(s.q)) storedDiffers += 1;
          }
          if (qtyDiff > 0) mismatches += 1;
          notice(`${qtyDiff === 0 ? "MATCH" : "MISMATCH"} GRN ${tag} Invoiced Qty = SQL sum of live invoice lines on ${out.rows.length - qtyDiff} / ${out.rows.length} lines; the stored grn_items.invoiced_qty differs from that sum on ${storedDiffers} lines (the export prints the sum)`);
          const acPo = out.rows.filter((r) => String(r[col("AutoCount Doc No")] ?? "").startsWith("PO-")).length;
          const acBlank = out.rows.filter((r) => r[col("AutoCount Doc No")] === null).length;
          if (acPo > 0) mismatches += 1;
          notice(`${acPo === 0 ? "MATCH" : "MISMATCH"} GRN ${tag} AutoCount Doc No holding a PO number: ${acPo} lines; blank: ${acBlank} / ${out.rows.length}`);
          const locs = new Map();
          for (const r of out.rows) locs.set(r[col("Location")], (locs.get(r[col("Location")]) ?? 0) + 1);
          notice(`GRN ${tag} Location values: ${[...locs].map(([k, v]) => `${k ?? "(blank)"}=${v}`).join(", ")}`);
          const linkedPo = out.rows.filter((r) => r[col("PO No.")] !== null).length;
          notice(`GRN ${tag} lines with a PO No.: ${linkedPo} / ${out.rows.length}; with an SO Doc No.: ${out.rows.filter((r) => r[col("SO Doc No.")] !== null).length}`);
        }
      }
    }

    /* ── Purchase Invoices ──────────────────────────────────────────────── */
    {
      const lineId = PI_LINE_EXPORT_COLUMNS.indexOf("Line ID");
      const cases = [
        ["posted tab", { ...noFilter, status: "posted" }, "AND h.status::text = ANY($2::text[])", [PI_STATUS_BUCKETS.posted]],
        ["All", noFilter, "", []],
        [`invoiced ${WINDOW_FROM}..${TODAY}`, { ...noFilter, from: WINDOW_FROM, to: TODAY }, "AND h.invoice_date >= $2 AND h.invoice_date <= $3", [WINDOW_FROM, TODAY]],
      ];
      for (const [name, filters, where, params] of cases) {
        const out = await run(sb, `PI ${tag} ${name}`, () => buildPiLineExport(sb, ctx, filters, TODAY));
        if (!out) continue;
        const want = await sqlSet("purchase_invoices", "purchase_invoice_items", "purchase_invoice_id", cid, where, params);
        compare(`PI ${tag} ${name}`, out, "piCount", want, lineId);
        if (name === "All") {
          const col = (n) => PI_LINE_EXPORT_COLUMNS.indexOf(n);
          const [link] = await pg`
            SELECT count(*) FILTER (WHERE g.id IS NOT NULL)::int AS grn
            FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
            LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id AND gi.company_id = ${cid}
            LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${cid}
            WHERE h.company_id = ${cid} AND i.company_id = ${cid}`;
          const exported = out.rows.filter((r) => r[col("GRN No.")] !== null).length;
          if (exported !== link.grn) mismatches += 1;
          notice(`${exported === link.grn ? "MATCH" : "MISMATCH"} PI ${tag} lines with a GRN No.: export ${exported}, SQL ${link.grn}, of ${out.rows.length}`);
          notice(`PI ${tag} lines with a blank Due Date (stored value only): ${out.rows.filter((r) => r[col("Due Date")] === null).length} / ${out.rows.length}`);
        }
      }
    }

    /* ── Sales Invoices ─────────────────────────────────────────────────── */
    {
      const lineId = SI_LINE_EXPORT_COLUMNS.indexOf("Line ID");
      const [seller] = await pg`
        SELECT salesperson_id::text AS id, count(*)::int AS n FROM scm.sales_invoices
        WHERE company_id = ${cid} AND salesperson_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1`;
      const cases = [
        ["sent tab", { ...noFilter, status: "sent" }, null, "AND h.status::text = ANY($2::text[])", [SI_STATUS_BUCKETS.sent]],
        ["All", noFilter, null, "", []],
        [`invoiced ${WINDOW_FROM}..${TODAY}`, { ...noFilter, from: WINDOW_FROM, to: TODAY }, null, "AND h.invoice_date >= $2 AND h.invoice_date <= $3", [WINDOW_FROM, TODAY]],
      ];
      if (seller) cases.push([`one seller's scope (${seller.n} invoices)`, noFilter, [seller.id], "AND h.salesperson_id = ANY($2::uuid[])", [[seller.id]]]);
      for (const [name, filters, scopeIds, where, params] of cases) {
        const out = await run(sb, `SI ${tag} ${name}`, () => buildSiLineExport(sb, ctx, filters, scopeIds, TODAY));
        if (!out) continue;
        const want = await sqlSet("sales_invoices", "sales_invoice_items", "sales_invoice_id", cid, where, params);
        compare(`SI ${tag} ${name}`, out, "siCount", want, lineId);
        if (name === "All") {
          const col = (n) => SI_LINE_EXPORT_COLUMNS.indexOf(n);
          const [link] = await pg`
            SELECT count(*) FILTER (WHERE d.id IS NOT NULL)::int AS dos,
                   count(*) FILTER (WHERE i.so_item_id IS NOT NULL)::int AS so_link
            FROM scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
            LEFT JOIN scm.delivery_order_items di ON di.id = i.do_item_id AND di.company_id = ${cid}
            LEFT JOIN scm.delivery_orders d ON d.id = di.delivery_order_id AND d.company_id = ${cid}
            WHERE h.company_id = ${cid} AND i.company_id = ${cid}`;
          const exported = out.rows.filter((r) => r[col("DO No.")] !== null).length;
          if (exported !== link.dos) mismatches += 1;
          notice(`${exported === link.dos ? "MATCH" : "MISMATCH"} SI ${tag} lines with a DO No. (through the DO line): export ${exported}, SQL ${link.dos}, of ${out.rows.length}; lines whose own so_item_id is set: ${link.so_link}`);
          /* Balance without a deposit is total − paid: check it on the invoices
             whose order took none, where SQL can say the number on its own. */
          const plain = await pg`
            SELECT h.id::text AS id, greatest(coalesce(nullif(h.total_sen,0), h.local_total_sen, 0) - coalesce(h.paid_sen,0), 0)::numeric AS bal
            FROM scm.sales_invoices h
            WHERE h.company_id = ${cid} AND NOT EXISTS (
              SELECT 1 FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = h.so_doc_no)
              AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_orders o WHERE o.doc_no = h.so_doc_no AND o.company_id = ${cid} AND coalesce(o.deposit_sen,0) > 0)`;
          const balById = new Map(plain.map((r) => [r.id, Number(r.bal) / 100]));
          const lineToSi = new Map((await pg`SELECT id::text AS id, sales_invoice_id::text AS si FROM scm.sales_invoice_items WHERE company_id = ${cid}`).map((r) => [r.id, r.si]));
          let checked = 0, off = 0;
          for (const r of out.rows) {
            const siId = lineToSi.get(String(r[lineId]));
            if (!balById.has(siId)) continue;
            checked += 1;
            if (Math.abs(Number(r[col("Balance")]) - balById.get(siId)) > 0.005) off += 1;
          }
          if (off > 0) mismatches += 1;
          notice(`${off === 0 ? "MATCH" : "MISMATCH"} SI ${tag} Balance = total − paid on ${checked - off} / ${checked} lines of invoices whose order holds no deposit; ${out.rows.length - checked} lines sit on an order with a deposit (Balance nets it)`);
          notice(`SI ${tag} lines with a blank Due Date (stored value only): ${out.rows.filter((r) => r[col("Due Date")] === null).length} / ${out.rows.length}`);
          const locs = new Map();
          for (const r of out.rows) locs.set(r[col("Location")], (locs.get(r[col("Location")]) ?? 0) + 1);
          notice(`SI ${tag} Location values: ${[...locs].map(([k, v]) => `${k ?? "(blank)"}=${v}`).join(", ")}`);
        }
      }
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
