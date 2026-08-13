// Relocate ALL 2990 (company_2) CONSIGNMENT stock to the PJ SHOWROOM.
//
// Owner 2026-08-02: "consignment 全部是 PJ showroom 的 —— 你全部帮我换 location
// 过去。KL warehouse 也没有 consignment 的，也换去 PJ showroom." The 2990
// consignment (held-not-owned, from HOOKKA via PC Receives) is currently spread
// across KL WAREHOUSE / PG WAREHOUSE / CHINA WAREHOUSE / PJ SHOWROOM; it should
// all sit at PJ SHOWROOM.
//
// SCOPE — CONSIGNMENT ONLY, company_2 ONLY. Consignment is identified by
// source_doc_type = 'PC_RECEIVE' on the lot / movement. OWNED (GRN) stock is
// NEVER touched. Consignment is excluded from stock value, so this moves no
// money, no COGS, no owned balance — only where held-not-owned display units are
// recorded.
//
// It rewrites the LOCATION consistently at every layer so the Stock Breakdown
// (lots) and the balance (movements) agree, and the receive doc matches:
//   1. inventory_lots.warehouse_id            (the lot's location)
//   2. inventory_movements.warehouse_id        for the lot's IN movement
//      (lot.movement_id) AND any OUT movements that consumed the lot
//   3. inventory_movements.warehouse_id        for ANY stray PC_RECEIVE movement
//   4. purchase_consignment_receives.warehouse_id (the source receive doc)
//
// Env: DATABASE_URL. APPLY=1 to write (default DRY-RUN). One transaction.
//
// RE-RUN: inert. A row already parked at PJ is either out of scope or matched by an IS DISTINCT FROM guard.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const num = (v) => Number(v ?? 0);

function fromDevVars(field) {
  try { return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1]; }
  catch { return undefined; }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

const COMPANY_ID = 2; // 2990

async function main() {
  notice("=== Relocate 2990 CONSIGNMENT stock -> PJ SHOWROOM ===");
  notice(APPLY ? "MODE: APPLY (will COMMIT)" : "MODE: DRY-RUN (no writes)");

  const [pj] = await sql`
    SELECT id, code, name FROM scm.warehouses
     WHERE (UPPER(code) LIKE 'PJ%SHOWROOM%' OR UPPER(name) LIKE 'PJ%SHOWROOM%')
       AND (is_showroom = true OR type = 'showroom')
     LIMIT 1`;
  if (!pj) { warn("PJ SHOWROOM warehouse not found. Aborting."); await sql.end(); return; }
  notice(`Target: [${pj.code ?? pj.name}] ${pj.id}`);

  // Consignment lots for 2990 NOT already at PJ.
  const lots = await sql`
    SELECT l.id, l.product_code, l.batch_no, l.qty_remaining, l.warehouse_id, l.movement_id,
           w.code AS wh_code
      FROM scm.inventory_lots l LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
     WHERE l.company_id = ${COMPANY_ID}
       AND UPPER(COALESCE(l.source_doc_type,'')) = 'PC_RECEIVE'
       AND l.warehouse_id IS DISTINCT FROM ${pj.id}
     ORDER BY w.code, l.product_code`;

  const strayMovs = await sql`
    SELECT COUNT(*)::int AS n FROM scm.inventory_movements
     WHERE company_id = ${COMPANY_ID} AND UPPER(COALESCE(source_doc_type,'')) = 'PC_RECEIVE'
       AND warehouse_id IS DISTINCT FROM ${pj.id}`;
  const pcrs = await sql`
    SELECT receive_number, warehouse_id, w.code AS wh_code
      FROM scm.purchase_consignment_receives r LEFT JOIN scm.warehouses w ON w.id = r.warehouse_id
     WHERE r.company_id = ${COMPANY_ID} AND r.warehouse_id IS DISTINCT FROM ${pj.id}
     ORDER BY receive_number`;

  if (lots.length === 0 && strayMovs[0].n === 0 && pcrs.length === 0) {
    notice("Nothing to do: all 2990 consignment already sits at PJ SHOWROOM. Clean.");
    await sql.end();
    return;
  }

  const byWh = new Map();
  for (const l of lots) {
    const g = byWh.get(l.wh_code ?? l.warehouse_id) ?? { qty: 0, lots: [] };
    g.qty += num(l.qty_remaining); g.lots.push(l); byWh.set(l.wh_code ?? l.warehouse_id, g);
  }
  notice("");
  notice(`Consignment LOTS to move to PJ SHOWROOM: ${lots.length} (units ${lots.reduce((a, l) => a + num(l.qty_remaining), 0)})`);
  for (const [wh, g] of byWh) {
    notice(`  from ${pad(wh, 16)} : ${g.qty} unit(s)`);
    for (const l of g.lots) notice(`      ${pad(l.product_code, 28)} qty ${pad(l.qty_remaining, 3)} <- ${l.batch_no ?? "(no batch)"}`);
  }
  notice(`Stray PC_RECEIVE movements not at PJ: ${strayMovs[0].n}`);
  notice(`PC Receive docs (PCR) to re-point to PJ: ${pcrs.length}  ${pcrs.map((p) => `${p.receive_number}(${p.wh_code})`).join(", ")}`);
  notice("");

  if (!APPLY) {
    notice("DRY-RUN — no writes. Re-run APPLY=1 to relocate all of the above to PJ SHOWROOM.");
    await sql.end();
    return;
  }

  let movedLots = 0, movedMovs = 0, movedPcr = 0;
  await sql.begin(async (tx) => {
    for (const l of lots) {
      const a = await tx`UPDATE scm.inventory_lots SET warehouse_id = ${pj.id} WHERE id = ${l.id}`;
      movedLots += a.count;
      if (l.movement_id) {
        const b = await tx`UPDATE scm.inventory_movements SET warehouse_id = ${pj.id} WHERE id = ${l.movement_id} AND warehouse_id IS DISTINCT FROM ${pj.id}`;
        movedMovs += b.count;
      }
      const c = await tx`
        UPDATE scm.inventory_movements SET warehouse_id = ${pj.id}
         WHERE id IN (SELECT movement_id FROM scm.inventory_lot_consumptions WHERE lot_id = ${l.id})
           AND warehouse_id IS DISTINCT FROM ${pj.id}`;
      movedMovs += c.count;
    }
    // any stray PC_RECEIVE IN movements not covered by a current lot
    const d = await tx`
      UPDATE scm.inventory_movements SET warehouse_id = ${pj.id}
       WHERE company_id = ${COMPANY_ID} AND UPPER(COALESCE(source_doc_type,'')) = 'PC_RECEIVE'
         AND warehouse_id IS DISTINCT FROM ${pj.id}`;
    movedMovs += d.count;
    // the receive docs
    const e = await tx`
      UPDATE scm.purchase_consignment_receives SET warehouse_id = ${pj.id}
       WHERE company_id = ${COMPANY_ID} AND warehouse_id IS DISTINCT FROM ${pj.id}`;
    movedPcr += e.count;
  });
  notice(`APPLIED: ${movedLots} lot(s), ${movedMovs} movement(s), ${movedPcr} receive doc(s) moved to PJ SHOWROOM.`);
  // verify
  const [{ left }] = await sql`
    SELECT COUNT(*)::int AS left FROM scm.inventory_lots
     WHERE company_id = ${COMPANY_ID} AND UPPER(COALESCE(source_doc_type,'')) = 'PC_RECEIVE'
       AND warehouse_id IS DISTINCT FROM ${pj.id} AND qty_remaining > 0`;
  notice(`On-hand consignment lots STILL not at PJ after apply: ${left} (expect 0).`);
  if (left > 0) warn(`${left} still off PJ — investigate.`);
}

main().then(() => sql.end()).catch(async (e) => {
  console.error("CONSIGNMENT_RELOCATE_FAIL", e?.message ?? e);
  await sql.end();
  process.exit(1);
});
