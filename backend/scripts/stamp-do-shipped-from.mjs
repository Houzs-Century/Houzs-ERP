#!/usr/bin/env node
/* Stamp the PO(s) and rack(s) onto the lines of delivery orders confirmed BEFORE
   the ship started locking them (mig 20261110T2300, owner rule 2026-11-10).

   白话：新的 DO 一确认就把「拿的是哪张 PO、从哪个 rack 拿」锁在每一行上。之前已经确认的
   DO 还没有锁，这个脚本按它们当时真正扣掉的库存批次和 rack 出库记录，补锁一次。
   已经锁过的行一律不碰。

   WHAT IT READS. For each confirmed DO (status LOADED .. INVOICED, not migrated
   paperwork) with at least one goods line whose shipped_from is NULL, the SAME
   planner the ship chokepoint runs: planDoShippedFrom in
   src/scm/lib/do-shipped-from-stamp.ts, driven through scripts/lib/pgrest-shim.mjs
   (reads only), so the backlog stamp and a new ship can never disagree. It walks
   the DO's FIFO lot consumptions (lot batch_no = PO, NULL-batch GRN lots healed
   via grns -> PO, adjustment lots counted as STOCK ADJ), batched OUT movements
   with no consumption (drop-ship), the forward trace's hard-bound PO for company
   1 (BUG-103), and the DO's own 'Delivery order dispatch' STOCK_OUT rack rows.
   A line with no such rack row (DOs before the rack stock-out) takes its rack
   from the chain PO -> that PO's POSTED GRN line(s) for the item in the line's
   ship-from warehouse -> the rack(s) the GRN line recorded (grn_item_racks split,
   else grn_items.rack_id), oldest GRN first, capped at the line qty (owner rule
   2026-11-10). A PO whose GRN recorded no rack gets no rack.
   ONLY A COMPLETE LINE IS LOCKED (owner decision 2026-11-10): a rack known for
   the full line qty AND a PO (or stock-adjustment lot) known for the full line
   qty. Any other line stays NULL, keeps the worked-out answer, and is retried by
   the nightly pass (scm/lib/do-shipped-from-retry.ts) until its GRN gets a rack.
   The plan prints per line either "lock" or "leave open: no rack for N of M" /
   "no PO for N of M".

   MODE=plan (default) prints, per DO, what each line would lock and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN" and writes one line at a
   time with `WHERE shipped_from IS NULL` (and the DB trigger refuses touching a
   set stamp), then re-reads every written line on a fresh connection and checks
   its SHAPE: a jsonb object with v = 1, a pos array and a racks array.

   Env: COMPANY_ID (optional, one company), DO_NOS (optional, comma list),
   LIMIT (optional, max DOs per run, default 2000).

   RE-RUN: convergent. Selection is keyed on shipped_from IS NULL; a stamped line
   is never selected again and the write cannot overwrite it. */
import "./lib/public-log-guard.mjs";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const COMPANY = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;
const DO_NOS = (process.env.DO_NOS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = Math.max(1, Math.min(20000, Number(process.env.LIMIT || 2000)));
const SHIPPED = ["LOADED", "DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED"];

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

const describe = (s) => {
  const pos = s.pos.map((p) => `${p.po}${p.qty == null ? "" : ` x${p.qty}`}`);
  if (s.adj_qty > 0) pos.push(`STOCK ADJ x${s.adj_qty}`);
  const racks = s.racks.map((r) => (r.via === "grn"
    ? `PO ${r.po} -> GRN ${r.grn} -> rack ${r.label ?? r.rack_id} x${r.qty} (via grn)`
    : `rack ${r.label ?? r.rack_id} x${r.qty} (via dispatch)`));
  return `PO ${pos.join(", ") || "-"} | ${racks.join("; ") || "rack -"}`;
};

async function main() {
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${COMPANY ?? "all"} do_nos=${DO_NOS.length || "all"} limit=${LIMIT}`);

  const dos = await sql`
    SELECT d.id::text AS id, d.do_number, d.company_id::int AS company_id, d.status::text AS status
      FROM scm.delivery_orders d
     WHERE d.status::text = ANY(${SHIPPED})
       AND COALESCE(d.migrated_no_stock, false) = false
       AND (${COMPANY}::int IS NULL OR d.company_id = ${COMPANY})
       AND (${DO_NOS.length === 0} OR d.do_number = ANY(${DO_NOS}))
       AND EXISTS (SELECT 1 FROM scm.delivery_order_items i
                    WHERE i.delivery_order_id = d.id AND i.shipped_from IS NULL AND i.qty > 0)
     ORDER BY d.created_at ASC
     LIMIT ${LIMIT}`;
  note(`\n=== ${dos.length} confirmed DO(s) with unstamped lines ===`);
  if (dos.length === 0) { note("Nothing to stamp."); await sql.end({ timeout: 5 }); return; }

  const { planDoShippedFrom } = await import("../src/scm/lib/do-shipped-from-stamp.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(sql, "scm");
  const assertNoShimGaps = (ctx) => {
    if (sb.__gaps.length === 0) return;
    bad(`SHIM GAP during ${ctx}; the planner called a method the shim does not implement, so its answer cannot be trusted:`);
    for (const g of sb.__gaps) bad(`  ${g}`);
    process.exit(1);
  };

  const writes = [];
  let unknownLines = 0;
  for (const d of dos) {
    const plan = await planDoShippedFrom(sb, d.id, d.company_id, "backfill");
    assertNoShimGaps(d.do_number);
    if (!plan) { bad(`  ${d.do_number}: lines unreadable, skipped`); continue; }
    const open = plan.lines.filter((l) => !l.shipped_from && Number(l.qty) > 0);
    note(`  ${d.do_number} (${d.status}, company ${d.company_id}): ${plan.stamps.size} of ${open.length} unstamped line(s) complete, will lock`);
    for (const l of open) {
      const s = plan.stamps.get(l.id);
      if (s) {
        note(`      ${String(l.item_code ?? "-").padEnd(24)} qty ${l.qty}  lock  ${describe(s)}`);
        writes.push({ doNo: d.do_number, companyId: d.company_id, lineId: l.id, stamp: s });
      } else {
        unknownLines += 1;
        note(`      ${String(l.item_code ?? "-").padEnd(24)} qty ${l.qty}  leave open: ${plan.open.get(l.id) || "nothing known"}`);
      }
    }
  }
  note(`\n  lines to lock: ${writes.length}   left open: ${unknownLines}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (writes.length === 0) { await sql.end({ timeout: 5 }); return; }

  note(`\n=== LOCKING ${writes.length} LINE(S) ===`);
  let wrote = 0;
  for (const w of writes) {
    /* $2::text::jsonb: the parameter arrives as TEXT and is PARSED into an
       object. A bare $2::jsonb on a serialized string stores a jsonb STRING
       (docs/jsonb-double-encoding-coe.md); the CHECK on the column would refuse
       it, and the read-back below checks the shape regardless. */
    const back = await sql.unsafe(
      `UPDATE scm.delivery_order_items SET shipped_from = $2::text::jsonb
        WHERE id = $1 AND company_id = $3 AND shipped_from IS NULL
       RETURNING id::text AS id`, [w.lineId, JSON.stringify(w.stamp), w.companyId]);
    wrote += back.length;
    if (!back.length) note(`  SKIP ${w.doNo} ${w.lineId} (stamped meanwhile)`);
  }
  note(`  written: ${wrote} of ${writes.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const ids = writes.map((w) => w.lineId);
    const rows = await check`
      SELECT id::text AS id, jsonb_typeof(shipped_from) AS shape,
             shipped_from->>'v' AS v, jsonb_typeof(shipped_from->'pos') AS pos_shape,
             jsonb_typeof(shipped_from->'racks') AS racks_shape, shipped_from->>'item_code' AS item_code
        FROM scm.delivery_order_items WHERE id = ANY(${ids}::uuid[])`;
    const wrong = rows.filter((r) => r.shape !== "object" || r.v !== "1" || r.pos_shape !== "array" || r.racks_shape !== "array");
    for (const r of wrong) bad(`  ${r.id}: shipped_from is ${r.shape}, v=${r.v}, pos ${r.pos_shape}, racks ${r.racks_shape}`);
    const missing = ids.length - rows.length;
    if (missing) bad(`  ${missing} written line(s) not found on re-read`);
    note(`  lines re-read: ${rows.length}; wrong shape: ${wrong.length}`);
    for (const r of rows.slice(0, 10)) note(`  ${r.id}: object v${r.v}, item ${r.item_code}`);
    if (wrong.length || missing) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
