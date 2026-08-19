// READ-ONLY drill: for one or more SO doc_no, dump the full SO -> DO -> inventory
// movement chain so a suspected DUPLICATE DELIVERY can be judged by evidence
// (owner 2026-08-03, off 2990-DO-2607-005 vs -017 on 2990-SO-2606-019: the
// duplicate-documents check flagged them 100%-identical AND both DISPATCHED, yet
// the over-delivery invariant R1 read 0 for every SO line). This drill shows WHY
// the two can both be true, and whether stock was actually deducted twice:
//
//   (1) SO lines: id, item, ordered qty, cancelled, stock_status.
//   (2) Each DO on the SO (any status): its lines with the so_item_id LINK state
//       — LINKED (points at one of this SO's lines) vs UNLINKED (NULL / other).
//       An UNLINKED twin is exactly what makes R1 blind: R1 sums delivered per
//       so_item_id, so a duplicate DO whose lines carry no so_item_id deducts
//       stock without ever counting against the ordered qty.
//   (3) The OUT/IN inventory_movements each DO posted (product, qty, warehouse,
//       batch) — the physical stock effect, independent of any SO link.
//   (4) Any delivery return offsetting those DOs.
//   (5) Per product: ordered vs net movement (OUT - IN) across ALL the SO's DOs,
//       and current on-hand — the truth-teller. net movement > ordered = stock
//       was deducted more than was ordered (a double-ship), regardless of R1.
//
// SELECTs only — no writes, no DDL, no transaction. Exit 0 for every legitimate
// answer; the output IS the answer (mirrors check-do-integrity.mjs's contract).
//   DATABASE_URL required (env, or .dev.vars for local use)
//   SO_DOCS       comma-separated SO doc_no list (default 2990-SO-2606-019)
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const SO_DOCS = (process.env.SO_DOCS || "2990-SO-2606-019")
  .split(",").map((s) => s.trim()).filter(Boolean);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const num = (x) => Number(x ?? 0);

try {
  notice(`=== SO -> DO -> movement drill (read-only) ===  SO_DOCS=${SO_DOCS.join(", ")}`);
  for (const so of SO_DOCS) {
    notice("");
    notice(`################ ${so} ################`);
    const hdr = await pg`
      SELECT doc_no, company_id, debtor_name,
             UPPER(COALESCE(status::text,'')) AS status
        FROM scm.mfg_sales_orders WHERE doc_no = ${so}`;
    if (hdr.length === 0) { notice(`  SO NOT FOUND.`); continue; }
    notice(`  SO status=${hdr[0].status}  customer=${hdr[0].debtor_name ?? "?"}  company=${hdr[0].company_id}`);

    // (1) SO lines
    const soLines = await pg`
      SELECT id::text AS id, item_code, qty, cancelled,
             UPPER(COALESCE(stock_status,'')) AS stock_status
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${so} ORDER BY item_code`;
    const soItemIds = new Set(soLines.map((l) => l.id));
    const orderedByCode = new Map();
    notice(`  --- SO lines (${soLines.length}) ---`);
    for (const l of soLines) {
      if (!l.cancelled) orderedByCode.set(l.item_code, num(orderedByCode.get(l.item_code)) + num(l.qty));
      notice(`    line ${l.id.slice(0, 8)}  ${l.item_code}  ordered=${l.qty}  ${l.cancelled ? "CANCELLED" : `stock=${l.stock_status}`}`);
    }

    // (2) DOs on this SO (any status)
    const dos = await pg`
      SELECT id::text AS id, do_number, UPPER(COALESCE(status::text,'')) AS status,
             do_date::text AS do_date, warehouse_id::text AS warehouse_id
        FROM scm.delivery_orders WHERE so_doc_no = ${so}
       ORDER BY do_date, do_number`;
    notice(`  --- DOs on this SO (${dos.length}) ---`);

    // per-product physical tally across ALL live DOs of this SO
    const outByCode = new Map();   // OUT movement qty
    const inByCode = new Map();    // IN movement qty (returns/reversals)

    for (const d of dos) {
      const live = !["CANCELLED", "DRAFT"].includes(d.status);
      const items = await pg`
        SELECT so_item_id::text AS so_item_id, item_code, qty
          FROM scm.delivery_order_items
         WHERE delivery_order_id = ${d.id}::uuid ORDER BY item_code`;
      const linked = items.filter((it) => it.so_item_id && soItemIds.has(it.so_item_id)).length;
      const unlinked = items.length - linked;
      notice(`    ${d.do_number}  status=${d.status}  date=${d.do_date}  wh=${d.warehouse_id ?? "?"}  lines=${items.length} (LINKED ${linked} / UNLINKED ${unlinked})`);
      for (const it of items) {
        const link = it.so_item_id ? (soItemIds.has(it.so_item_id) ? `LINKED ${it.so_item_id.slice(0, 8)}` : `OTHER-SO ${it.so_item_id.slice(0, 8)}`) : "UNLINKED(null)";
        notice(`        ${it.item_code}  qty=${it.qty}  [${link}]`);
      }
      const moves = await pg`
        SELECT movement_type, item_code, variant_key, qty,
               warehouse_id::text AS warehouse_id, batch_no
          FROM scm.inventory_movements
         WHERE source_doc_type = 'DO' AND source_doc_id = ${d.id}::uuid
         ORDER BY item_code`;
      if (moves.length) {
        notice(`        movements (${moves.length}):`);
        for (const m of moves) {
          notice(`          ${m.movement_type}  ${m.item_code}  qty=${m.qty}  wh=${m.warehouse_id ?? "?"}  batch=${m.batch_no ?? "-"}`);
          if (live) {
            const bucket = String(m.movement_type).toUpperCase() === "OUT" ? outByCode : inByCode;
            bucket.set(m.item_code, num(bucket.get(m.item_code)) + Math.abs(num(m.qty)));
          }
        }
      }
    }

    // (4) returns offsetting these DOs
    const rets = await pg`
      SELECT d.do_number, dri.qty_returned, doi.item_code,
             UPPER(COALESCE(dr.status::text,'')) AS status
        FROM scm.delivery_return_items dri
        JOIN scm.delivery_returns dr ON dr.id = dri.delivery_return_id
        JOIN scm.delivery_order_items doi ON doi.id = dri.do_item_id
        JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
       WHERE d.so_doc_no = ${so}
         AND UPPER(COALESCE(dr.status::text,'')) <> 'CANCELLED'`;
    notice(`  --- returns against this SO's DOs (${rets.length}) ---`);
    for (const r of rets) notice(`    ${r.do_number}  ${r.item_code}  returned=${r.qty_returned}  status=${r.status}`);

    // (5) per-product verdict: ordered vs net physical movement vs on-hand
    notice(`  --- PER-PRODUCT: ordered vs NET stock-out vs on-hand ---`);
    const codes = new Set([...orderedByCode.keys(), ...outByCode.keys()]);
    for (const code of [...codes].sort()) {
      const ordered = num(orderedByCode.get(code));
      const out = num(outByCode.get(code));
      const inn = num(inByCode.get(code));
      const net = out - inn;
      const onHandRow = await pg`
        SELECT COALESCE(SUM(qty_remaining),0)::int AS n
          FROM scm.inventory_lots
         WHERE company_id = ${hdr[0].company_id} AND item_code = ${code} AND qty_remaining > 0`;
      const flag = net > ordered ? `  ** NET STOCK-OUT ${net} > ORDERED ${ordered} — DOUBLE-DEDUCTED ${net - ordered} **` : "";
      notice(`    ${code}  ordered=${ordered}  OUT=${out}  IN=${inn}  NET_OUT=${net}  on_hand_now=${onHandRow[0].n}${flag}`);
    }
  }
  notice("");
  notice("DONE (read-only). Read PER-PRODUCT: NET_OUT > ordered means stock left twice for a single order — the duplicate DO physically double-deducted. Nothing was written.");
} finally {
  await pg.end({ timeout: 5 });
}
