// Read-only: how many database REQUESTS one export call makes, per list.
//
// WHY. A Cloudflare Worker may make at most 1,000 subrequests per request. Each
// supabase-js read (a page of headers, a batch of lines, a lookup, a stamp) is
// one HTTPS subrequest to PostgREST. The SO export measured 1,394 (Submitted)
// and 1,923 (All) on 2026-09-15 — over the cap, so it would fail live. This
// counts the same for the PO, Goods Received, Purchase Invoice and Sales Invoice
// exports on their WORST tab (All, no search), per company, by running each
// export's own code over the read-only PostgREST stand-in (lib/pgrest-shim.mjs)
// and counting every awaited query builder — one builder = one PostgREST request.
//
// Not counted: the auth middleware's own reads before the handler runs (a
// handful). SI is counted for the view-all tier (no sales-scope lookups), the
// tier that reads the most invoices.
//
// Exits 0 for every answer; non-zero only when the database cannot be reached.
// RE-RUN: Actions -> "GRN / PI / SI line export check (read-only)" -> Run workflow
//         (npx tsx scripts/count-export-requests.mjs)
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

const CAP = 1000;
const HEADROOM = 800;

/* Wrap a shim client so every awaited builder counts once. */
function counting(sb) {
  const counter = { n: 0, byTable: new Map() };
  const wrap = (builder, table) => new Proxy(builder, {
    get(t, prop) {
      if (prop === "then") {
        return (res, rej) => {
          counter.n += 1;
          counter.byTable.set(table, (counter.byTable.get(table) ?? 0) + 1);
          return t.then(res, rej);
        };
      }
      const v = t[prop];
      if (typeof v !== "function") return v;
      return (...args) => {
        const r = v.apply(t, args);
        return r && typeof r === "object" && typeof r.then === "function" ? wrap(r, table) : r;
      };
    },
  });
  const client = new Proxy(sb, {
    get(t, prop) {
      if (prop === "from") return (table) => wrap(t.from(table), table);
      return t[prop];
    },
  });
  return { client, counter };
}

try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  /* PO: the same reads as buildPoExportRows, with the header select stripped of
     its FK-hinted warehouse embed the shim cannot parse (as check-po-line-export.mjs
     does). An embed rides inside the header request, so the COUNT is unchanged. */
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
  const { readGrnExportRows } = await import("../src/scm/lib/grn-export-rows.ts");
  const { readPiExportRows } = await import("../src/scm/lib/pi-export-rows.ts");
  const { readSiExportRows } = await import("../src/scm/lib/si-export-rows.ts");
  const { stampSoDates, stampDoNumber, stampOrderDeposit } = await import("../src/scm/lib/si-list-stamps.ts");
  const { stampSourcePos } = await import("../src/scm/routes/sales-invoices.ts");

  const noFilter = { status: null, supplierId: null, q: null, from: null, to: null, sort: null };
  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  let over = 0;

  for (const co of companies) {
    const cid = Number(co.id);
    const ctx = { get: (k) => (k === "companyId" ? cid : undefined) };
    const cases = [
      ["PO All", async (sb) => { const o = await buildPoExportRows(sb, ctx, noFilter, new Set()); return [o.error, o.purchaseOrders?.length, o.lineCount]; }],
      ["GRN All", async (sb) => { const o = await readGrnExportRows(sb, ctx, noFilter); return [o.error, o.rows?.length, o.lineCount]; }],
      ["PI All", async (sb) => { const o = await readPiExportRows(sb, ctx, noFilter); return [o.error, o.rows?.length, o.lineCount]; }],
      ["SI All (view-all, with the handler's header stamps)", async (sb) => {
        const o = await readSiExportRows(sb, ctx, noFilter, null);
        if (o.error !== null) return [o.error, 0, 0];
        for (let i = 0; i < o.rows.length; i += 100) {
          const batch = o.rows.slice(i, i + 100);
          await stampSoDates(sb, batch);
          await stampDoNumber(sb, batch);
          await stampSourcePos(sb, batch);
          await stampOrderDeposit(sb, batch, cid);
        }
        return [null, o.rows.length, o.lineCount];
      }],
    ];
    for (const [label, run] of cases) {
      const shim = pgrestShim(pg, "scm");
      const { client, counter } = counting(shim);
      const t0 = Date.now();
      let res;
      try { res = await run(client); } catch (e) { res = [String(e?.message ?? e), 0, 0]; }
      const ms = Date.now() - t0;
      if (shim.__gaps.length > 0) {
        notice(`GAP company ${cid} ${co.code} ${label}: the shim could not run a read, count incomplete: ${shim.__gaps.join(" | ")}`);
        over += 1;
        continue;
      }
      const [err, docs, lines] = res;
      const top = [...counter.byTable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ${n}`).join(", ");
      const verdict = counter.n >= CAP ? "OVER CAP" : counter.n > HEADROOM ? "OVER HEADROOM" : "UNDER";
      if (counter.n > HEADROOM) over += 1;
      notice(`${verdict} company ${cid} ${co.code} ${label}: ${counter.n} requests for ${docs} docs / ${lines} lines (${ms} ms)${err ? `; error: ${err}` : ""}; by table: ${top}`);
    }
  }
  notice(over === 0
    ? `VERDICT: every counted export call stays at or under ${HEADROOM} requests (cap ${CAP}).`
    : `VERDICT: ${over} export call(s) above ${HEADROOM} requests or not countable.`);
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
