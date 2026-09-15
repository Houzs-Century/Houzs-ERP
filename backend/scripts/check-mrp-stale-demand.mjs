// check-mrp-stale-demand — READ-ONLY. Which sales-order lines is MRP still
// planning for, and has the goods on them already gone out — in the ERP or in
// the AutoCount book?
//
// Owner, 2026-09-15: 「为什么很多明显都出货了，还在占用着 MRP 的库存？」 and
// 「开了 DO 的东西就代表已经不需要这个货了…既然它是没有需求的，就不应该进 MRP 啊」 and
// 「你可能要去查看一下 AutoCount 那边原本是怎么样的，看它会不会有可能是 partial delivery，
// 然后是不是真的有 processing date」.
//
// Runs the CANONICAL engine (computeMrp over lib/pgrest-shim.mjs behind a guard
// that refuses every write), takes every line the engine still plans for, and
// for each one reads:
//   ERP    the order's status, processing date, effective delivery date, whether
//          ANY delivery order of that order exists (any status, DRAFT included),
//          whether a DO line of THIS line exists, whether a sales invoice exists,
//          when the line was created;
//   BOOK   the AutoCount line it came from (linked_ac_dtlkey) in the committed
//          snapshot backend/scripts/data/ac-convert-edges.json.gz: its qty, how much
//          of it AutoCount transferred to a DO/invoice, and whether the book
//          order is cancelled.
// It prints counts by delivery-date state x book state x ERP delivery state,
// the stock and units each bucket holds, and one JSON row per order ("ROW ").
//
// Exit 0 for every answer; non-zero only when the database or the engine cannot run.
// RE-RUN: read-only and idempotent.
import postgres from "postgres";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 30);
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 120 });

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
const [{ today }] = await sql`SELECT to_char((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') AS today`;
notice(`=== MRP stale demand — READ-ONLY · company ${COMPANY} · today ${today} (MYT) ===`);

/* ── the book ─────────────────────────────────────────────────────────── */
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, "data", "ac-convert-edges.json.gz"))).toString("utf8"));
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
const bookHdr = new Map(snap.types.SO.headers.map((h) => [h[H.docNo], { date: h[H.docDate], cancelled: h[H.cancelled] === "T" }]));
const bookLine = new Map();
for (const r of snap.types.SO.lines) {
  bookLine.set(String(r[L.dtlKey]), { docNo: r[L.docNo], item: r[L.itemKey], qty: Number(r[L.qty] || 0), toDo: Number(r[L.transferedQty] || 0), transferable: r[L.transferable] });
}
notice(`AutoCount snapshot exported_at ${snap.exported_at} · ${bookHdr.size} SO headers · ${bookLine.size} SO lines`);

/* ── the engine ───────────────────────────────────────────────────────── */
const t0 = Date.now();
let mrp;
try {
  const { computeMrp } = await import("../src/scm/routes/mrp.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const shim = pgrestShim(sql, "scm");
  mrp = await computeMrp(readOnlyGuard(shim), {
    catFilter: null, whFilter: null, includeUndated: true, companyId: COMPANY,
    leadBuffers: { supplierBufferDays: {}, seasonBufferDays: {} },
  });
  if (shim.__gaps?.length) { notice(`ENGINE DID NOT RUN CLEANLY — shim gaps: ${shim.__gaps.join(" | ")}`); process.exit(1); }
} catch (e) { notice(`ENGINE DID NOT RUN — ${e.message}`); process.exit(1); }
const planned = new Map();
for (const sku of mrp.skus) for (const l of sku.lines) planned.set(l.soItemId, { qty: l.qty, stock: l.stockQty ?? 0, short: l.shortageQty ?? 0, po: l.poNumber, delivery: l.deliveryDate, cat: sku.category ?? sku.itemGroup ?? null });
for (const s of mrp.sofaSets) planned.set(s.soItemId, { qty: s.qty, stock: s.stockQty ?? 0, short: s.shortageQty ?? 0, po: s.poNumber, delivery: s.deliveryDate, cat: "sofa" });
notice(`engine ran in ${Math.round((Date.now() - t0) / 1000)}s · ${planned.size} sales-order lines still planned`);

/* ── the ERP facts for those lines ────────────────────────────────────── */
const ids = [...planned.keys()];
const facts = [];
for (let i = 0; i < ids.length; i += 2000) {
  const batch = ids.slice(i, i + 2000);
  facts.push(...await sql`
    SELECT i.id::text AS id, i.doc_no, i.line_no, i.item_code, i.item_group, i.qty::float AS qty, i.linked_ac_dtlkey::text AS ac_key,
           to_char(i.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS line_created,
           h.status::text AS so_status, h.processing_date::text AS processing, h.customer_delivery_date::text AS header_delivery,
           h.so_date::text AS so_date, h.linked_ac_docno AS ac_doc, h.debtor_name,
           to_char(h.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS so_created,
           to_char(h.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS so_updated,
           EXISTS (SELECT 1 FROM scm.delivery_orders o WHERE o.so_doc_no = h.doc_no AND o.company_id = h.company_id AND o.status::text <> 'CANCELLED') AS order_has_do,
           (SELECT string_agg(DISTINCT o.status::text, ',') FROM scm.delivery_orders o WHERE o.so_doc_no = h.doc_no AND o.company_id = h.company_id AND o.status::text <> 'CANCELLED') AS do_states,
           EXISTS (SELECT 1 FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                    WHERE di.so_item_id = i.id AND o.status::text <> 'CANCELLED') AS line_on_do,
           EXISTS (SELECT 1 FROM scm.sales_invoice_items si WHERE si.so_item_id = i.id) AS line_on_si
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.id::text = ANY(${batch}) AND h.company_id = ${COMPANY}`);
}

const bookState = (f) => {
  const key = f.ac_key;
  const bookDoc = String(f.ac_doc ?? f.doc_no.replace(/^HC-/, "")).trim().toUpperCase();
  if (!key && !bookHdr.has(bookDoc)) return "NOT_IN_BOOK";
  if (bookHdr.get(bookDoc)?.cancelled) return "BOOK_CANCELLED";
  const b = key ? bookLine.get(key) : null;
  if (!b) return "BOOK_LINE_NOT_FOUND";
  if (b.qty > 0 && b.toDo >= b.qty) return "BOOK_DELIVERED";
  if (b.toDo > 0) return "BOOK_PARTIAL";
  return "BOOK_OPEN";
};
const dateState = (d) => (!d ? "UNDATED" : d < today ? "EXPIRED" : "FUTURE");
const erpState = (f) => (f.line_on_do ? "LINE_ON_DO" : f.order_has_do ? "ORDER_HAS_OTHER_DO" : "NO_DO");

const rows = facts.map((f) => {
  const p = planned.get(f.id);
  return { ...f, ...p, date_state: dateState(p.delivery), book: bookState(f), erp: erpState(f) };
});

const tally = (keyFn) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const t = m.get(k) ?? { lines: 0, orders: new Set(), units: 0, stock: 0 };
    t.lines++; t.orders.add(r.doc_no); t.units += Number(r.qty) || 0; t.stock += Number(r.stock) || 0;
    m.set(k, t);
  }
  return [...m.entries()].sort((a, b) => b[1].lines - a[1].lines);
};
const printTally = (title, keyFn) => {
  notice(title);
  for (const [k, t] of tally(keyFn)) say(`   ${pad(k, 58)} lines ${pad(t.lines, 6)} orders ${pad(t.orders.size, 5)} units ${pad(t.units, 6)} holding stock ${t.stock}`);
};
printTally("A. by delivery date", (r) => r.date_state);
printTally("B. by delivery date x AutoCount book", (r) => `${r.date_state} · ${r.book}`);
printTally("C. by delivery date x ERP delivery order", (r) => `${r.date_state} · ${r.erp}`);
printTally("D. EXPIRED only: book x ERP x processing date", (r) => r.date_state !== "EXPIRED" ? "(not expired)" : `${r.book} · ${r.erp} · ${r.processing ? "HAS_PROCESSING" : "NO_PROCESSING"}`);
printTally("E. EXPIRED only: by year the order was dated", (r) => r.date_state !== "EXPIRED" ? "(not expired)" : `so_date ${String(r.so_date ?? "?").slice(0, 7)}`);
printTally("F. EXPIRED only: by the day the line entered the ERP", (r) => r.date_state !== "EXPIRED" ? "(not expired)" : `line created ${r.line_created}`);

const byOrder = new Map();
for (const r of rows.filter((x) => x.date_state === "EXPIRED")) {
  const o = byOrder.get(r.doc_no) ?? { doc_no: r.doc_no, debtor: r.debtor_name, so_status: r.so_status, so_date: r.so_date, processing: r.processing, delivery: r.delivery, so_created: r.so_created, so_updated: r.so_updated, do_states: r.do_states, lines: [] };
  o.lines.push({ line_no: r.line_no, item: r.item_code, group: r.item_group, qty: r.qty, stock: r.stock, short: r.short, po: r.po, book: r.book, erp: r.erp, line_created: r.line_created });
  byOrder.set(r.doc_no, o);
}
const orders = [...byOrder.values()].sort((a, b) => String(a.delivery).localeCompare(String(b.delivery)));
notice(`EXPIRED orders still planned by MRP: ${orders.length}`);
for (const o of orders.slice(0, SHOW)) {
  say(`   ${pad(o.doc_no, 14)} ${pad(o.so_status, 13)} delivery ${pad(o.delivery, 10)} processing ${pad(o.processing ?? "-", 10)} DOs ${pad(o.do_states ?? "-", 18)} ${o.lines.map((l) => `ln${l.line_no} ${l.item} x${l.qty} [${l.book}/${l.erp}]`).join("; ").slice(0, 220)}`);
}
for (const o of orders) console.log("ROW " + JSON.stringify(o));
if (process.env.OUT_FILE) fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ today, snapshot: snap.exported_at, orders, all: rows }));
notice("READ-ONLY — nothing was written.");
await sql.end();
