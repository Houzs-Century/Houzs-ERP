// Read-only check of the Purchase Return and Delivery Return list exports
// (GET /api/scm/purchase-returns/export/rows, /delivery-returns/export/rows,
// 2026-09-15) against the live data.
//
// WHY. Each export must hold EVERY line of every return the list's filter (and,
// for delivery returns, the caller's sales scope) matches, with no screen cap.
// The unit tests prove it against a fake; this runs each export's OWN code —
// buildPurchaseReturnExportRows / buildDeliveryReturnExportRows, the functions
// the routes call — over the real database and compares the answer with a
// direct SQL read of the same rows, LINE ID BY LINE ID, and the money in sen
// line by line. There is no service login to call the Worker from Actions, so
// the transport is the repo's read-only PostgREST stand-in (lib/pgrest-shim.mjs,
// CLAUDE.md R88); a query shape the shim cannot run is a GAP and the run says it
// proved nothing. Zero rows is a valid answer and is printed as such.
//
// Per company: All, one status, and for delivery returns one seller's scope.
//
// Strictly read-only: the session is set READ ONLY before the first query and
// the export code only SELECTs. Exits 0 for every answer, MISMATCH included.
// Non-zero only for an unreachable database.
//
// RE-RUN: Actions -> "Return line export check (read-only)" -> Run workflow
//         (runs under tsx: npx tsx scripts/check-return-line-export.mjs)
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const pg = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  types: { dateText: asText(1082), timestampText: asText(1114), timestamptzText: asText(1184) },
});

let mismatches = 0;

async function sqlSet(headerTable, lineTable, fk, lineMoney, companyId, where, params) {
  const docs = await pg.unsafe(
    `SELECT count(*)::int AS n FROM scm.${headerTable} h WHERE h.company_id = $1 ${where}`, [companyId, ...params]);
  const lines = await pg.unsafe(
    `SELECT i.id::text AS id, i.${lineMoney}::numeric AS money FROM scm.${lineTable} i JOIN scm.${headerTable} h ON h.id = i.${fk}
     WHERE h.company_id = $1 AND i.company_id = $1 ${where}`, [companyId, ...params]);
  return { docs: docs[0].n, money: new Map(lines.map((r) => [r.id, r.money === null ? null : Number(r.money)])) };
}

function compare(label, out, docsKey, lineMoney, want) {
  const lines = out[docsKey].flatMap((d) => d.lines);
  const got = new Map(lines.map((l) => [l.id, l[lineMoney]]));
  const missing = [...want.money.keys()].filter((id) => !got.has(id));
  const extra = [...got.keys()].filter((id) => !want.money.has(id));
  const moneyOff = [...got].filter(([id, v]) => want.money.has(id) && (v ?? null) !== want.money.get(id)).length;
  const ok = out.total === want.docs && out.lineCount === want.money.size && got.size === lines.length
    && missing.length === 0 && extra.length === 0 && moneyOff === 0 && out.truncated === false;
  if (!ok) mismatches += 1;
  notice(
    `${ok ? "MATCH" : "MISMATCH"} ${label}: export ${out.total} returns / ${lines.length} lines (truncated=${out.truncated}); ` +
      `SQL ${want.docs} returns / ${want.money.size} lines; line ids missing ${missing.length}, extra ${extra.length}; ` +
      `${lineMoney} differing from SQL ${moneyOff}` +
      (want.docs === 0 && out.total === 0 ? " (0 rows: nothing matches, which is the answer)" : ""),
  );
}

async function run(sb, label, fn) {
  const t0 = Date.now();
  const out = await fn();
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
  notice(`${label}: ran in ${Date.now() - t0} ms`);
  return out;
}

try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db, ro }] = await pg`SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro`;
  notice(`database: ${db}; session read-only: ${ro}; at ${new Date().toISOString()}`);

  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const { buildPurchaseReturnExportRows } = await import("../src/scm/lib/purchase-return-list-read.ts");
  const { buildDeliveryReturnExportRows } = await import("../src/scm/lib/delivery-return-list-read.ts");
  const sb = pgrestShim(pg, "scm");
  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;

  for (const co of companies) {
    const cid = Number(co.id);
    const ctx = { get: (k) => (k === "companyId" ? cid : k === "companyCode" ? co.code : undefined) };
    const tag = `company ${cid} ${co.code}`;

    const prStatuses = await pg`SELECT status::text AS s, count(*)::int AS n FROM scm.purchase_returns WHERE company_id = ${cid} GROUP BY 1 ORDER BY 2 DESC`;
    const prCases = [["All", { status: null, supplierId: null }, "", []]];
    if (prStatuses[0]) prCases.push([`status ${prStatuses[0].s}`, { status: prStatuses[0].s, supplierId: null }, "AND h.status::text = $2", [prStatuses[0].s]]);
    else prCases.push(["status POSTED", { status: "POSTED", supplierId: null }, "AND h.status::text = $2", ["POSTED"]]);
    for (const [name, filters, where, params] of prCases) {
      const out = await run(sb, `PR ${tag} ${name}`, () => buildPurchaseReturnExportRows(sb, ctx, filters));
      if (!out) continue;
      const want = await sqlSet("purchase_returns", "purchase_return_items", "purchase_return_id", "line_refund_sen", cid, where, params);
      compare(`PR ${tag} ${name}`, out, "purchaseReturns", "line_refund_sen", want);
    }

    const drStatuses = await pg`SELECT status::text AS s, count(*)::int AS n FROM scm.delivery_returns WHERE company_id = ${cid} GROUP BY 1 ORDER BY 2 DESC`;
    const [seller] = await pg`
      SELECT salesperson_id::text AS id, count(*)::int AS n FROM scm.delivery_returns
      WHERE company_id = ${cid} AND salesperson_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1`;
    const drCases = [["All (view-all caller)", { status: null }, null, "", []]];
    if (drStatuses[0]) drCases.push([`status ${drStatuses[0].s}`, { status: drStatuses[0].s }, null, "AND h.status::text = $2", [drStatuses[0].s]]);
    else drCases.push(["status RECEIVED", { status: "RECEIVED" }, null, "AND h.status::text = $2", ["RECEIVED"]]);
    if (seller) drCases.push([`one seller's scope (${seller.n} returns)`, { status: null }, [seller.id], "AND h.salesperson_id = ANY($2::uuid[])", [[seller.id]]]);
    for (const [name, filters, scopeIds, where, params] of drCases) {
      const out = await run(sb, `DR ${tag} ${name}`, () => buildDeliveryReturnExportRows(sb, ctx, filters, scopeIds, false));
      if (!out) continue;
      const want = await sqlSet("delivery_returns", "delivery_return_items", "delivery_return_id", "line_total_sen", cid, where, params);
      compare(`DR ${tag} ${name}`, out, "deliveryReturns", "line_total_sen", want);
      if (name.startsWith("All")) {
        const leaked = out.deliveryReturns.filter((d) => "total_cost_sen" in d || d.lines.some((l) => "unit_cost_sen" in l)).length;
        if (leaked > 0) mismatches += 1;
        notice(`${leaked === 0 ? "MATCH" : "MISMATCH"} DR ${tag} cost keys in a non-finance caller's rows: ${leaked}`);
        for (const d of out.deliveryReturns) {
          notice(`DR ${tag} ${d.return_number} ${d.status}: ${d.lines.length} lines; Agent=${d.ac_agent ?? "(blank)"}; ` +
            d.lines.map((l) => `[${l.item_code} | ${l.description} | ${l.item_group} | ${l.uom} | Location=${l.location ?? "(blank)"} | SO=${l.so_doc_no ?? "(blank)"}]`).join(" "));
        }
      }
    }
  }

  notice(mismatches === 0
    ? "VERDICT: each export's own code returns exactly the returns and lines a direct SQL read returns, per company, for every filter above."
    : `VERDICT: ${mismatches} MISMATCH / GAP / error line(s) above.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
