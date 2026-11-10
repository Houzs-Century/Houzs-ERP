// Read-only: one item's full stock ledger in one company — every movement, every
// FIFO lot and every lot consumption, plus the DO lines that shipped it — so a
// "why does this line show no PO" or "is on-hand right" question is answered
// from production rows instead of from the app's derived screens.
//
//   ITEM_CODE=CODY-(K) COMPANY_ID=2 node backend/scripts/check-item-lot-ledger.mjs
//   Actions -> "Run a backend script on production": script check-item-lot-ledger.mjs,
//   mode plan, env  ITEM_CODE=CODY-(K);COMPANY_ID=2
//
// SELECTs only. Exits 0 for every real answer (an empty ledger is an answer);
// only a missing input, an unreachable database or a query error exits non-zero.
import "./lib/public-log-guard.mjs";
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

const ITEM = (process.env.ITEM_CODE ?? "").trim();
const CO = Number(process.env.COMPANY_ID ?? "");
const url = resolveUrl();
if (!ITEM || !Number.isInteger(CO) || CO <= 0 || !url) {
  console.error("Needs ITEM_CODE, COMPANY_ID and DATABASE_URL.");
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const iso = (t) => (t ? new Date(t).toISOString().replace(".000Z", "Z") : "-");
const cut = (s, n) => (s == null ? "" : String(s).replace(/\s+/g, " ").slice(0, n));

try {
  /* The schema facts the DO-return path depends on: the consumption table's
     columns (prod-only DDL) and the return function's parameter names, which a
     PostgREST call must spell exactly. */
  const cols = await pg`SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'inventory_lot_consumptions' ORDER BY ordinal_position`;
  console.log(`== inventory_lot_consumptions columns: ${cols.map((c) => c.column_name).join(", ")}`);
  const fns = await pg`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'scm' AND p.proname IN ('fn_return_do_units_at_cost', 'fn_reverse_do_out')`;
  for (const f of fns) console.log(`== fn ${f.proname}(${f.args})`);

  const wh = new Map((await pg`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`)
    .map((w) => [w.id, w.code || w.name]));
  const whOf = (id) => wh.get(id) ?? String(id).slice(0, 8);

  const movs = await pg`
    SELECT id, created_at, movement_type, warehouse_id, variant_key, batch_no, qty,
           unit_cost_sen, total_cost_sen, source_doc_type, source_doc_no, correction_seq, notes
      FROM scm.inventory_movements
     WHERE company_id = ${CO} AND item_code = ${ITEM}
     ORDER BY created_at, id`;
  console.log(`== MOVEMENTS ${ITEM} company ${CO}: ${movs.length}`);
  for (const m of movs) {
    console.log([iso(m.created_at), m.movement_type, `qty=${m.qty}`, whOf(m.warehouse_id), `vk=${m.variant_key ?? ""}`,
      `batch=${m.batch_no ?? ""}`, `${m.source_doc_type}:${m.source_doc_no ?? ""}`, `seq=${m.correction_seq ?? ""}`,
      `costed=${Number(m.total_cost_sen ?? 0) > 0 ? "yes" : "no"}`, `mov=${String(m.id).slice(0, 8)}`, cut(m.notes, 110)].join(" | "));
  }

  const net = new Map();
  for (const m of movs) {
    const k = `${whOf(m.warehouse_id)} vk=${m.variant_key ?? ""}`;
    const q = Number(m.qty ?? 0);
    const s = m.movement_type === "IN" ? q : m.movement_type === "OUT" ? -Math.abs(q) : m.movement_type === "ADJUSTMENT" ? q : 0;
    net.set(k, (net.get(k) ?? 0) + s);
  }

  const lots = await pg`
    SELECT id, received_at, warehouse_id, variant_key, batch_no, qty_received, qty_remaining,
           unit_cost_sen, source_doc_type, source_doc_no, movement_id
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND item_code = ${ITEM}
     ORDER BY received_at, id`;
  console.log(`\n== LOTS: ${lots.length}`);
  const lotSum = new Map();
  for (const l of lots) {
    const k = `${whOf(l.warehouse_id)} vk=${l.variant_key ?? ""}`;
    lotSum.set(k, (lotSum.get(k) ?? 0) + Number(l.qty_remaining ?? 0));
    console.log([iso(l.received_at), `lot=${String(l.id).slice(0, 8)}`, whOf(l.warehouse_id), `vk=${l.variant_key ?? ""}`,
      `batch=${l.batch_no ?? ""}`, `recv=${l.qty_received}`, `left=${l.qty_remaining}`, `costed=${Number(l.unit_cost_sen ?? 0) > 0 ? "yes" : "no"}`,
      `${l.source_doc_type}:${l.source_doc_no ?? ""}`, `mov=${String(l.movement_id ?? "").slice(0, 8)}`].join(" | "));
  }

  const cons = await pg`
    SELECT c.lot_id, c.movement_id, c.qty_consumed, c.unit_cost_sen, c.source_doc_type, c.source_doc_no, c.variant_key
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
     WHERE l.company_id = ${CO} AND l.item_code = ${ITEM}
     ORDER BY c.id`;
  console.log(`\n== CONSUMPTIONS: ${cons.length}`);
  for (const c of cons) {
    console.log([`lot=${String(c.lot_id).slice(0, 8)}`, `mov=${String(c.movement_id ?? "").slice(0, 8)}`,
      `qty=${c.qty_consumed}`, `${c.source_doc_type}:${c.source_doc_no ?? ""}`, `vk=${c.variant_key ?? ""}`].join(" | "));
  }

  console.log(`\n== ON-HAND PER BUCKET: movements net vs open lots`);
  for (const k of new Set([...net.keys(), ...lotSum.keys()])) {
    const a = net.get(k) ?? 0;
    const b = lotSum.get(k) ?? 0;
    console.log(`${k} | movements=${a} | lots=${b}${a === b ? "" : " | DIFFERS"}`);
  }

  const lines = await pg`
    SELECT d.do_number, d.status, i.id, i.line_no, i.qty, i.item_group, i.variants, i.rack_id, i.shipped_from
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.company_id = ${CO} AND i.item_code = ${ITEM}
       AND d.id IN (SELECT DISTINCT source_doc_id FROM scm.inventory_movements
                     WHERE company_id = ${CO} AND item_code = ${ITEM} AND source_doc_type = 'DO')
     ORDER BY d.do_number, i.line_no`;
  console.log(`\n== DO LINES that moved ${ITEM}: ${lines.length}`);
  for (const l of lines) {
    console.log([l.do_number, l.status, `line=${l.line_no}`, `qty=${l.qty}`, `group=${l.item_group ?? ""}`,
      `variants=${cut(JSON.stringify(l.variants), 160)}`, 
      `shipped_from=${cut(JSON.stringify(l.shipped_from), 200)}`].join(" | "));
  }
} finally {
  await pg.end({ timeout: 5 });
}
