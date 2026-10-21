// Stamp the dye-lot batch on sofa units a Delivery Return booked back into
// stock WITHOUT one (2990-0011, Sim 2026-10-20).
//
// WHY. 2990-DR-2610-001 returned the XAMMAR 2A(LHF) + L(RHF) set that
// 2990-DO-2607-012 shipped from batch 2990-PO-2606-010. The DR took its batch
// from mfg_sales_order_items.allocated_batch_no, which is cleared once an order
// is delivered, so both units re-entered KL WAREHOUSE as un-batched lots. MRP's
// sofa set walk (and the allocator's dye-lot match, and the DO batch gate) read
// batched lots only, so MRP showed the set SHORT and asked purchasing to order
// it again while the SO page said READY. The route fix makes new returns take
// the batch the DO shipped from; this script heals the returns already booked.
//
// EVIDENCE. A DR IN movement is stamped only when every DR line of that code
// points (do_item_id) at a DO whose OWN shipment of that code names exactly one
// batch: the DO's batched OUT movements plus the batches of the lots its OUT
// consumed, same variant first, any variant of the code if the variant matched
// none. The batch must be a purchase order of the same company. Sofa lines only
// (delivery_return_items.item_group). Anything else is printed as REFUSED and
// left alone.
//
// WHAT IT WRITES. inventory_lots.batch_no on the lots that movement opened
// (movement_id) and inventory_movements.batch_no on the movement itself, in
// one transaction per movement. Quantities, costs, balances, timestamps are
// untouched. The allocator / MRP pick the batch up on their next run.
//
// REVERSAL: set batch_no back to NULL on the lot ids and movement ids the
// apply log prints.
//
// RE-RUN: idempotent. A stamped movement no longer has a NULL batch_no, so a
// second plan lists zero rows and a second apply writes nothing; a lot that
// gained a DIFFERENT batch in between is refused inside the transaction.
//
//   DATABASE_URL  required (env, or .dev.vars for local use)
//   MODE          plan (default) | apply
//   CONFIRM       STAMP-DR-SOFA-BATCH on apply
//   DR_NOS        optional comma list of return numbers to limit the run
import { readFileSync } from "node:fs";
import postgres from "postgres";

const MODE = process.env.MODE ?? "plan";
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "STAMP-DR-SOFA-BATCH";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`refuses to apply: CONFIRM must be exactly "${CONFIRM_PHRASE}"`);
  process.exit(1);
}
const DR_NOS = (process.env.DR_NOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

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
  console.error("no DATABASE_URL — set it in the environment or .dev.vars");
  process.exit(1);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const blank = (s) => String(s ?? "").trim() === "";

const plans = [];
const refusals = [];
try {
  log(`=== repair-dr-sofa-lot-batch  mode=${APPLY ? "APPLY" : "PLAN"}${DR_NOS.length ? `  DR_NOS=${DR_NOS.join(",")}` : ""} ===`);

  const movements = await pg`
    SELECT m.id::text AS id, m.company_id, m.warehouse_id::text AS warehouse_id,
           m.item_code, COALESCE(m.variant_key, '') AS variant_key, m.qty,
           m.source_doc_id::text AS dr_id, m.source_doc_no AS dr_no, m.created_at
      FROM scm.inventory_movements m
     WHERE m.source_doc_type = 'DR' AND m.movement_type = 'IN'
       AND (m.batch_no IS NULL OR btrim(m.batch_no) = '')
       AND EXISTS (
         SELECT 1 FROM scm.delivery_return_items i
          WHERE i.delivery_return_id::text = m.source_doc_id::text
            AND i.item_code = m.item_code
            AND upper(COALESCE(i.item_group, '')) LIKE '%SOFA%')
       ${DR_NOS.length > 0 ? pg`AND m.source_doc_no = ANY(${DR_NOS})` : pg``}
     ORDER BY m.created_at, m.id`;
  log(`un-batched sofa DR IN movements: ${movements.length}`);

  for (const m of movements) {
    const lines = await pg`
      SELECT i.id::text AS id, d.delivery_order_id::text AS do_id, s.doc_no AS so_doc_no
        FROM scm.delivery_return_items i
        LEFT JOIN scm.delivery_order_items d ON d.id = i.do_item_id
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = d.so_item_id
       WHERE i.delivery_return_id::text = ${m.dr_id} AND i.item_code = ${m.item_code}
         AND upper(COALESCE(i.item_group, '')) LIKE '%SOFA%'`;
    const tag = `${m.dr_no}  ${m.item_code}  [${m.variant_key}]  qty ${m.qty}`;
    if (lines.length === 0 || lines.some((l) => !l.do_id)) {
      refusals.push({ tag, reason: "a DR line has no DO line to trace" });
      continue;
    }
    const doIds = [...new Set(lines.map((l) => l.do_id))];
    const shipped = await pg`
      SELECT o.batch_no AS batch, COALESCE(o.variant_key, '') AS vk
        FROM scm.inventory_movements o
       WHERE o.source_doc_type = 'DO' AND o.movement_type = 'OUT'
         AND o.source_doc_id::text = ANY(${doIds}) AND o.item_code = ${m.item_code}
         AND o.batch_no IS NOT NULL AND btrim(o.batch_no) <> ''
      UNION ALL
      SELECT l.batch_no AS batch, COALESCE(c.variant_key, '') AS vk
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_lots l ON l.id = c.lot_id
       WHERE c.source_doc_type = 'DO'
         AND c.source_doc_id::text = ANY(${doIds}) AND c.item_code = ${m.item_code}
         AND l.batch_no IS NOT NULL AND btrim(l.batch_no) <> ''`;
    const exact = shipped.filter((r) => r.vk === m.variant_key);
    const batches = [...new Set((exact.length > 0 ? exact : shipped).map((r) => r.batch.trim()))];
    if (batches.length !== 1) {
      refusals.push({ tag, reason: batches.length === 0 ? "the DO shipment names no batch" : `the DO shipped from ${batches.length} batches (${batches.join(", ")})` });
      continue;
    }
    const batch = batches[0];
    const po = await pg`
      SELECT po_number FROM scm.purchase_orders WHERE po_number = ${batch} AND company_id = ${m.company_id}`;
    if (po.length !== 1) {
      refusals.push({ tag, reason: `batch ${batch} is not one purchase order of company ${m.company_id}` });
      continue;
    }
    const lots = await pg`
      SELECT id::text AS id, batch_no, qty_received, qty_remaining
        FROM scm.inventory_lots WHERE movement_id::text = ${m.id}`;
    const clash = lots.find((l) => !blank(l.batch_no) && l.batch_no !== batch);
    if (clash) {
      refusals.push({ tag, reason: `lot ${clash.id} already carries batch ${clash.batch_no}` });
      continue;
    }
    plans.push({ m, batch, lots: lots.filter((l) => blank(l.batch_no)), sos: [...new Set(lines.map((l) => l.so_doc_no).filter(Boolean))] });
  }

  log("");
  for (const p of plans) {
    log(`PLAN  ${p.m.dr_no}  ${p.m.item_code}  [${p.m.variant_key}]  qty ${p.m.qty}  SO ${p.sos.join(",") || "-"}  -> batch ${p.batch}`);
    log(`      movement ${p.m.id}; lots ${p.lots.map((l) => `${l.id} (rem ${l.qty_remaining}/${l.qty_received})`).join(", ") || "none"}`);
  }
  for (const r of refusals) log(`REFUSED  ${r.tag}: ${r.reason}`);
  log("");
  log(`${plans.length} movement(s) to stamp, ${plans.reduce((n, p) => n + p.lots.length, 0)} lot(s); ${refusals.length} refused.`);

  if (!APPLY) {
    log("PLAN complete — nothing written. MODE=apply CONFIRM=" + CONFIRM_PHRASE + " to write.");
  } else {
    for (const p of plans) {
      await pg.begin(async (sql) => {
        const cur = await sql`
          SELECT batch_no FROM scm.inventory_movements WHERE id::text = ${p.m.id} FOR UPDATE`;
        if (!blank(cur[0]?.batch_no)) {
          if (cur[0].batch_no !== p.batch) throw new Error(`movement ${p.m.id} batch changed underneath to '${cur[0].batch_no}' — refusing`);
          return;
        }
        for (const l of p.lots) {
          const now = await sql`SELECT batch_no FROM scm.inventory_lots WHERE id::text = ${l.id} FOR UPDATE`;
          if (!blank(now[0]?.batch_no) && now[0].batch_no !== p.batch) throw new Error(`lot ${l.id} batch changed underneath to '${now[0].batch_no}' — refusing`);
          await sql`UPDATE scm.inventory_lots SET batch_no = ${p.batch} WHERE id::text = ${l.id} AND (batch_no IS NULL OR btrim(batch_no) = '')`;
        }
        await sql`UPDATE scm.inventory_movements SET batch_no = ${p.batch} WHERE id::text = ${p.m.id} AND (batch_no IS NULL OR btrim(batch_no) = '')`;
      });
      log(`APPLIED  ${p.m.dr_no}  ${p.m.item_code} -> ${p.batch}  movement ${p.m.id}  lots ${p.lots.map((l) => l.id).join(", ") || "none"}`);
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}

if (APPLY && plans.length > 0) {
  const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    let bad = 0;
    for (const p of plans) {
      const mv = await verify`SELECT batch_no FROM scm.inventory_movements WHERE id::text = ${p.m.id}`;
      if (mv[0]?.batch_no !== p.batch) { bad += 1; log(`VERIFY FAIL  movement ${p.m.id} batch_no='${mv[0]?.batch_no ?? null}', expected '${p.batch}'`); }
      for (const l of p.lots) {
        const lot = await verify`SELECT batch_no, qty_received, qty_remaining FROM scm.inventory_lots WHERE id::text = ${l.id}`;
        if (lot[0]?.batch_no !== p.batch || Number(lot[0]?.qty_remaining) !== Number(l.qty_remaining) || Number(lot[0]?.qty_received) !== Number(l.qty_received)) {
          bad += 1;
          log(`VERIFY FAIL  lot ${l.id} batch_no='${lot[0]?.batch_no ?? null}' rem ${lot[0]?.qty_remaining}/${lot[0]?.qty_received}, expected '${p.batch}' rem ${l.qty_remaining}/${l.qty_received}`);
        }
      }
    }
    log(bad === 0 ? `VERIFY OK — every stamped movement and lot reads its batch on a fresh connection, quantities unchanged.` : `VERIFY: ${bad} mismatch(es).`);
    if (bad > 0) process.exitCode = 1;
  } finally {
    await verify.end({ timeout: 5 });
  }
}
