// check-hard-bound-coverage — READ-ONLY. "We already raised the PO — why does
// MRP still say SHORT?" asked of EVERY per-order (hard-bound) line at once.
//
// Owner, 2026-09-15: 「我的 MRP 那边还有没有一些问题？就是我们明明已经开了 PO，可是它
// 又显示着 shortage」 and 「SI、SO 跟 source PO 等等，都是要对应解决掉的」.
//
// Runs the CANONICAL engine (computeMrp + mrpLineCoverage over lib/pgrest-shim.mjs,
// behind a guard that refuses every write) and, for every live sofa / bedframe /
// Sofa Accessory sales-order line of the company, reports:
//   1. MIS-ASSIGNED   the engine names a PO that is NOT this line's own PO
//   2. SHORT-WITH-PO  the engine says shortage while the line's own open PO covers its qty
//   3. OVER-ORDERED   the line is on live POs for MORE than its quantity (double PO)
//   4. PO WITHOUT SO  a live hard-bound PO line pointing at no sales-order line
//   5. DO / SI NOT LINKED  a live delivery-order or sales-invoice line of a
//      hard-bound item that names no sales-order line (the per-line lock and the
//      remaining quantity cannot see it)
// Each class prints its count and the first SHOW documents.
//
// Exit 0 for every answer; non-zero only when the database or the engine cannot run.
// RE-RUN: read-only and idempotent.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 25);
const GROUPS = ["sofa", "bedframe", "fabric_accessory"];
const PO_DEAD = ["CANCELLED", "DRAFT"];
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const { SO_TERMINAL_STATES } = await import("./lib/so-terminal-states.mjs");
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

function readOnlyGuard(shim) {
  const WRITES = new Set(["update", "insert", "upsert", "delete", "rpc"]);
  return new Proxy(shim, {
    get(target, prop, recv) {
      if (prop === "rpc") return () => { throw new Error("read-only check: rpc refused"); };
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (table) => {
        const b = target.from(table);
        return new Proxy(b, {
          get(bt, p, r) {
            if (WRITES.has(String(p))) return () => { throw new Error(`read-only check: ${String(p)} on ${table} refused`); };
            return Reflect.get(bt, p, r);
          },
        });
      };
    },
  });
}

try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }
notice(`=== hard-bound coverage — READ-ONLY · company ${COMPANY} · groups ${GROUPS.join(", ")} ===`);

const t0 = Date.now();
let cov;
try {
  const { computeMrp, mrpLineCoverage } = await import("../src/scm/routes/mrp.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const shim = pgrestShim(sql, "scm");
  const mrp = await computeMrp(readOnlyGuard(shim), {
    catFilter: null, whFilter: null, includeUndated: true, companyId: COMPANY,
    leadBuffers: { supplierBufferDays: {}, seasonBufferDays: {} },
  });
  if (shim.__gaps?.length) { notice(`ENGINE DID NOT RUN CLEANLY — shim gaps: ${shim.__gaps.join(" | ")}`); process.exit(1); }
  cov = mrpLineCoverage(mrp);
  notice(`engine ran in ${Math.round((Date.now() - t0) / 1000)}s · ${mrp.skus.length} SKU rows`);
} catch (e) { notice(`ENGINE DID NOT RUN — ${e.message}`); process.exit(1); }

const lines = await sql`
  SELECT i.id::text AS id, i.doc_no, i.line_no, i.item_code, i.item_group, i.qty, h.customer_delivery_date::text AS delivery, h.status::text AS so_status,
         coalesce((SELECT json_agg(json_build_object('po', p.po_number, 'qty', it.qty, 'rcv', coalesce(it.received_qty, 0)))
            FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
           WHERE it.so_item_id = i.id AND p.status::text <> ALL(${PO_DEAD})), '[]'::json) AS own
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE h.company_id = ${COMPANY} AND lower(coalesce(i.item_group, '')) = ANY(${GROUPS}) AND NOT i.cancelled
     AND h.status::text <> ALL(${SO_TERMINAL_STATES})`;

const cls = { mis: [], shortWithPo: [], over: [] };
const byGroup = {};
for (const l of lines) {
  const g = (byGroup[l.item_group] ??= { lines: 0, mis: 0, shortWithPo: 0, over: 0, noEntry: 0 });
  g.lines++;
  const own = (l.own ?? []);
  const ownPos = own.map((o) => o.po);
  const ownOpen = own.reduce((s, o) => s + Math.max(0, Number(o.qty) - Number(o.rcv)), 0);
  const ordered = own.reduce((s, o) => s + Number(o.qty), 0);
  const c = cov.get(l.id);
  if (!c) g.noEntry++;
  else if (c.po && !ownPos.includes(c.po)) { g.mis++; cls.mis.push({ l, why: `engine names ${c.po}; own: ${ownPos.join(", ") || "none"}` }); }
  else if (c.source === "shortage" && ownOpen >= Number(l.qty)) { g.shortWithPo++; cls.shortWithPo.push({ l, why: `own ${ownPos.join(", ")} has ${ownOpen} open` }); }
  if (ordered > Number(l.qty)) { g.over++; cls.over.push({ l, why: `qty ${l.qty}, on live POs ${ordered}: ${own.map((o) => `${o.po}x${o.qty}`).join(", ")}` }); }
}
const print = (title, rows) => {
  notice(`${title}: ${rows.length}`);
  for (const { l, why } of rows.slice(0, SHOW)) say(`   ${pad(l.doc_no, 14)} ln ${pad(l.line_no, 3)} ${pad(l.item_code, 18)} [${pad(l.item_group, 16)}] qty ${pad(l.qty, 3)} ${pad(l.so_status, 14)} delivery ${pad(l.delivery ?? "—", 10)} — ${why}`);
};
for (const [g, v] of Object.entries(byGroup)) notice(`  ${pad(g, 16)} ${v.lines} live lines · mis-assigned ${v.mis} · short-with-own-PO ${v.shortWithPo} · over-ordered ${v.over} · not in engine ${v.noEntry}`);
print("1. MIS-ASSIGNED (engine covers the line with somebody else's PO)", cls.mis);
print("2. SHORT-WITH-PO (own open PO covers the qty, engine still says shortage)", cls.shortWithPo);
print("3. OVER-ORDERED (line on live POs for more than its qty)", cls.over);

const poNoSo = await sql`
  SELECT p.po_number, p.status::text AS st, it.line_no, it.item_code, it.item_group, it.qty, coalesce(it.received_qty, 0) AS rcv
    FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
   WHERE p.company_id = ${COMPANY} AND p.status::text <> ALL(${PO_DEAD}) AND it.so_item_id IS NULL
     AND lower(coalesce(it.item_group, '')) = ANY(${GROUPS}) AND coalesce(it.received_qty, 0) < it.qty
   ORDER BY p.po_number`;
notice(`4. PO WITHOUT SO (live, not fully received, hard-bound, no sales-order link): ${poNoSo.length}`);
for (const r of poNoSo.slice(0, SHOW)) say(`   ${pad(r.po_number, 15)} ${pad(r.st, 12)} ln ${pad(r.line_no, 3)} ${pad(r.item_code, 18)} [${r.item_group}] qty ${r.qty} recv ${r.rcv}`);

const doNoSo = await sql`
  SELECT o.do_number AS doc, o.status::text AS st, it.item_code, it.item_group, it.qty
    FROM scm.delivery_order_items it JOIN scm.delivery_orders o ON o.id = it.delivery_order_id
   WHERE o.company_id = ${COMPANY} AND o.status::text <> 'CANCELLED' AND it.so_item_id IS NULL
     AND lower(coalesce(it.item_group, '')) = ANY(${GROUPS}) ORDER BY o.do_number`;
const siNoSo = await sql`
  SELECT v.invoice_number AS doc, v.status::text AS st, it.item_code, it.item_group, it.qty
    FROM scm.sales_invoice_items it JOIN scm.sales_invoices v ON v.id = it.sales_invoice_id
   WHERE v.company_id = ${COMPANY} AND v.status::text NOT IN ('CANCELLED','VOID') AND it.so_item_id IS NULL
     AND lower(coalesce(it.item_group, '')) = ANY(${GROUPS}) ORDER BY v.invoice_number`;
notice(`5. DO / SI lines of hard-bound items with no sales-order link: DO ${doNoSo.length} · SI ${siNoSo.length}`);
for (const r of [...doNoSo, ...siNoSo].slice(0, SHOW)) say(`   ${pad(r.doc, 18)} ${pad(r.st, 12)} ${pad(r.item_code, 18)} [${r.item_group}] qty ${r.qty}`);

notice("READ-ONLY — nothing was written.");
await sql.end();
