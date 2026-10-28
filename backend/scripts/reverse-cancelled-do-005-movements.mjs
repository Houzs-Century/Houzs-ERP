#!/usr/bin/env node
/* Reverse the stock a CANCELLED duplicate delivery order never gave back.

   THE BUSINESS EFFECT (plain words). Sales order 2990-SO-2606-019 (customer
   Andrew khoo) was shipped twice: a genuine delivery (2990-DO-2607-017,
   DISPATCHED) and a duplicate (2990-DO-2607-005). The duplicate was later
   CANCELLED, but its stock never came back — the warehouse still shows three
   items shipped out that are physically on the shelf. So on-hand is short by
   1 mattress, 2 pillows and 1 divan for no real reason.

   WHAT PROD LOOKS LIKE (verified 2026-08-19 via the SO-DO drill workflow —
   .github/workflows/so-do-drill.yml, backend/scripts/check-so-do-drill.mjs).
   2990-DO-2607-005 is status=CANCELLED, company_id=2, and still owns three OUT
   inventory_movements at warehouse 41d544bc-cb3b-424a-8629-e3e27e14df5f that
   were never reversed:
       2990 KETTA-FIRM MATT (K)          qty 1
       NTYR MEMORY CONTOUR PILLOW        qty 2
       TRION-(K)                         qty 1
   The genuine DO on this SO, 2990-DO-2607-017 (DISPATCHED), is NOT touched by
   this repair.

   ROOT CAUSE (traced, not guessed — delivery-orders-mfg.ts). When the duplicate
   was cancelled, reverseInventoryForDo's result was discarded by a best-effort
   try/catch, so a movement-write failure left the shipped stock deducted with a
   clean 200 (the exact defect the current code's contract comment warns about,
   lines 1891-1895). The over-delivery invariant R1 was blind to the double-ship
   because DO-005's lines carry NULL so_item_id — R1 sums delivered per
   so_item_id, so an UNLINKED duplicate deducts stock without ever counting
   against the ordered qty.

   THE REPAIR IS THE SYSTEM'S OWN REVERSAL, run for this ONE document. It calls
   the canonical cancel-path function scm.fn_reverse_do_out(p_do_id,
   p_performed_by, p_batched_only := false) — the exact function
   reverseInventoryForDo invokes for a non-drop-ship DO cancel (migration 0198,
   recreated with item_code in 0307). Scoped by source_doc_id = DO-005's id, it
   touches ONLY this DO's buckets: it restores each OUT's original lots at their
   original cost, deletes the cancelled sale's lot consumptions, zeroes the OUT
   cost stamps, and writes one balancing +net_out ADJUSTMENT per bucket whose
   trigger-minted lot is immediately closed. So inventory_balances (signed by
   movement_type) nets back UP by exactly the qty each OUT removed — +1 / +2 / +1
   — and no ad-hoc rows are hand-crafted. DO-2607-017 has a different id and is
   untouched by construction.

   REFUSES rather than guesses. Before writing anything it asserts DO-2607-005 is
   company_id=2 AND status=CANCELLED AND not drop-ship, and that its OUT
   movements are EXACTLY those three (KETTA 1, NTYR 2, TRION 1) at that warehouse
   with no IN movements. Any other shape aborts with exit 2.

   MODE=plan (default) prints the current stock and exactly what it would reverse
   and writes nothing. MODE=apply requires CONFIRM="REVERSE DO-2607-005 OUT
   MOVEMENTS", reverses inside one transaction, then re-reads on a FRESH
   connection and asserts the per-item stock deltas are exactly +1 / +2 / +1, the
   three canonical ADJUSTMENT rows exist, and 2990-DO-2607-017's movements are
   unchanged.

   NOTE ON THE WRITE PATH: the physical write is performed server-side by
   scm.fn_reverse_do_out, so this file carries no INSERT/UPDATE/DELETE statement
   of its own; it nonetheless carries all four release-discipline artefacts (mode
   gate, confirm phrase, fresh-connection shape verification, this re-run note)
   because it does reach production.

   RE-RUN: idempotent no-op. scm.fn_reverse_do_out short-circuits to 0 when an
   ADJUSTMENT row already tags this DO, and this script detects that same prior
   reversal up front and exits without touching the ledger — a second run can
   never double-reverse the stock. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REVERSE DO-2607-005 OUT MOVEMENTS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* The document, its company, its warehouse and its exact OUT shape — all pinned.
   The SO-DO drill established every one of these on 2026-08-19; the script proves
   they still hold before it writes, and refuses if the world has moved. */
const DO_DOCNO = '2990-DO-2607-005';
const KEEP_DOCNO = '2990-DO-2607-017'; // the genuine DO — must stay untouched
const COMPANY = 2;
const WAREHOUSE = '41d544bc-cb3b-424a-8629-e3e27e14df5f';
/* Expected OUT movements, matched by a distinctive item_code substring so the
   assertion cannot silently pass on a different item that happens to share a qty. */
const EXPECTED = [
  { key: 'KETTA', qty: 1 },
  { key: 'NTYR', qty: 2 },
  { key: 'TRION', qty: 1 },
];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Resolve a DO by its do_number to { id, company_id, status, warehouse_id, is_dropship }. */
async function resolveDo(client, docNo) {
  let rows;
  try {
    rows = await client`
      SELECT id::text AS id, company_id, UPPER(COALESCE(status::text, '')) AS status,
             warehouse_id::text AS warehouse_id, is_dropship
        FROM scm.delivery_orders WHERE do_number = ${docNo}`;
  } catch (e) {
    /* Forward/backward-compat: is_dropship may be absent on an older schema. */
    if (!(e.message ?? '').includes('is_dropship')) throw e;
    rows = await client`
      SELECT id::text AS id, company_id, UPPER(COALESCE(status::text, '')) AS status,
             warehouse_id::text AS warehouse_id, FALSE AS is_dropship
        FROM scm.delivery_orders WHERE do_number = ${docNo}`;
  }
  return rows;
}

/** THE OUT/IN shape of a DO's inventory_movements: per item_code, the OUT sum,
 *  IN sum, and the distinct warehouses touched. This is the shape both the plan
 *  assertion and the untouched-DO verification read. */
async function movementShape(client, doId) {
  const rows = await client`
    SELECT item_code,
           MAX(product_name) AS product_name,
           COALESCE(SUM(qty) FILTER (WHERE movement_type = 'OUT'), 0)::int AS out_qty,
           COALESCE(SUM(qty) FILTER (WHERE movement_type = 'IN'), 0)::int  AS in_qty,
           COUNT(*)::int AS n,
           COALESCE(SUM(total_cost_sen), 0)::bigint AS total_cost_sen,
           string_agg(DISTINCT warehouse_id::text, ',') AS warehouses
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO' AND source_doc_id = ${doId}::uuid
     GROUP BY item_code ORDER BY item_code`;
  return rows;
}

/** Signed on-hand per item (SUM across variant buckets) at the repair warehouse
 *  — inventory_balances signs OUT negative and ADJUSTMENT signed, so this is the
 *  physical truth the reversal must move, never a naive SUM(qty). */
async function onHand(client, itemCodes) {
  if (itemCodes.length === 0) return new Map();
  const rows = await client`
    SELECT item_code, COALESCE(SUM(qty), 0)::int AS qty
      FROM scm.inventory_balances
     WHERE company_id = ${COMPANY} AND warehouse_id = ${WAREHOUSE}::uuid
       AND item_code = ANY(${itemCodes})
     GROUP BY item_code`;
  return new Map(rows.map((r) => [r.item_code, Number(r.qty)]));
}

/** Match DO-005's actual OUT movements against EXPECTED, returning the resolved
 *  item_code strings or a list of reasons to refuse. */
function matchExpected(shape) {
  const reasons = [];
  const outRows = shape.filter((r) => r.out_qty > 0);
  const inRows = shape.filter((r) => r.in_qty > 0);
  if (inRows.length) reasons.push(`DO has ${inRows.length} item(s) with IN movements (expected none): ${inRows.map((r) => r.item_code).join(', ')}`);
  if (outRows.length !== EXPECTED.length) reasons.push(`DO has ${outRows.length} OUT item(s), expected ${EXPECTED.length}`);

  const resolved = [];
  const used = new Set();
  for (const exp of EXPECTED) {
    const hits = outRows.filter((r) => String(r.item_code).toUpperCase().includes(exp.key)
      || String(r.product_name ?? '').toUpperCase().includes(exp.key));
    if (hits.length !== 1) { reasons.push(`expected exactly one OUT item matching "${exp.key}", found ${hits.length}`); continue; }
    const hit = hits[0];
    used.add(hit.item_code);
    if (hit.out_qty !== exp.qty) reasons.push(`"${exp.key}" (${hit.item_code}) OUT qty is ${hit.out_qty}, expected ${exp.qty}`);
    const whs = String(hit.warehouses ?? '').split(',').filter(Boolean);
    if (whs.length !== 1 || whs[0] !== WAREHOUSE) reasons.push(`"${exp.key}" (${hit.item_code}) warehouse is ${hit.warehouses}, expected ${WAREHOUSE}`);
    resolved.push({ ...exp, item_code: hit.item_code, product_name: hit.product_name });
  }
  const unmatched = outRows.filter((r) => !used.has(r.item_code));
  if (unmatched.length) reasons.push(`unmatched OUT item(s): ${unmatched.map((r) => r.item_code).join(', ')}`);
  return { resolved, reasons };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}  target=${DO_DOCNO}  company=${COMPANY}`);

  // ── Resolve and assert the document shape ──────────────────────────────────
  const doRows = await resolveDo(sql, DO_DOCNO);
  if (doRows.length !== 1) { bad(`expected exactly one ${DO_DOCNO}, found ${doRows.length} — refusing`); await sql.end({ timeout: 5 }); process.exit(2); }
  const doRow = doRows[0];
  const doId = doRow.id;
  note(`\n=== TARGET DO ===`);
  note(`  ${DO_DOCNO}  id=${doId}  company=${doRow.company_id}  status=${doRow.status}  dropship=${doRow.is_dropship}`);

  const refuse = [];
  if (Number(doRow.company_id) !== COMPANY) refuse.push(`company_id is ${doRow.company_id}, expected ${COMPANY}`);
  if (doRow.status !== 'CANCELLED') refuse.push(`status is ${doRow.status}, expected CANCELLED`);
  if (doRow.is_dropship === true) refuse.push(`DO is drop-ship — the drop-ship cancel path differs and is out of this repair's analysed scope`);

  // ── Already reversed? Then this is a no-op, in either mode ─────────────────
  const [{ existing }] = await sql`
    SELECT COUNT(*)::int AS existing FROM scm.inventory_movements
     WHERE source_doc_type = 'ADJUSTMENT' AND source_doc_id = ${doId}::uuid`;
  if (Number(existing) > 0) {
    note(`\n=== ALREADY REVERSED ===`);
    note(`  ${existing} ADJUSTMENT row(s) already tag ${DO_DOCNO} — its stock was restored on a prior run.`);
    note(`  Nothing to do. scm.fn_reverse_do_out and this script are both no-ops here.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── Assert the OUT shape is exactly the three known phantom movements ───────
  const shape = await movementShape(sql, doId);
  note(`\n=== DO-005 INVENTORY MOVEMENTS (source_doc_type='DO') ===`);
  for (const r of shape) note(`  ${String(r.item_code).padEnd(30)} OUT=${r.out_qty} IN=${r.in_qty} rows=${r.n} cost_sen=${r.total_cost_sen} wh=${r.warehouses}`);
  const { resolved, reasons } = matchExpected(shape);
  for (const r of reasons) refuse.push(r);

  if (refuse.length) {
    note(`\n=== REFUSING — the document does not match the analysed shape ===`);
    for (const r of refuse) bad(`  ${r}`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  // ── Before-state: on-hand at the warehouse, and the genuine DO's fingerprint ─
  const itemCodes = resolved.map((r) => r.item_code);
  const before = await onHand(sql, itemCodes);
  const keepRows = await resolveDo(sql, KEEP_DOCNO);
  const keepId = keepRows[0]?.id ?? null;
  const keepBefore = keepId ? await movementShape(sql, keepId) : [];

  note(`\n=== CURRENT ON-HAND (inventory_balances, signed) AT ${WAREHOUSE} ===`);
  for (const r of resolved) {
    note(`  ${String(r.item_code).padEnd(30)} on_hand=${before.get(r.item_code) ?? 0}  would become ${(before.get(r.item_code) ?? 0) + r.qty}  (restore +${r.qty})`);
  }
  note(`\n  Genuine DO ${KEEP_DOCNO} (${keepId ?? 'NOT FOUND'}): ${keepBefore.length} item bucket(s) — will be left untouched.`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to reverse.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── APPLY: the canonical reversal, for this one DO, in one transaction ──────
  note(`\n=== APPLYING scm.fn_reverse_do_out(${DO_DOCNO}, batched_only=false) ===`);
  let written;
  await sql.begin(async (tx) => {
    const rows = await tx`SELECT scm.fn_reverse_do_out(${doId}::uuid, ${null}::uuid, false) AS written`;
    written = Number(rows[0].written);
    /* The fn writes one balancing ADJUSTMENT per bucket with net_out > 0. Our
       three OUT buckets each have net_out = OUT qty, so it must write 3. Any
       other count means the world changed under us — roll the whole thing back. */
    if (written !== EXPECTED.length) throw new Error(`fn_reverse_do_out reversed ${written} bucket(s), expected ${EXPECTED.length} — rolling back`);
  });
  note(`  fn reversed ${written} bucket(s).`);

  // ── VERIFY ON A FRESH CONNECTION — assert the SHAPE, not a row count ────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const problems = [];
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);

    // 1. Per-item stock delta must be exactly the qty each OUT removed.
    const after = await onHand(check, itemCodes);
    for (const r of resolved) {
      const b = before.get(r.item_code) ?? 0;
      const a = after.get(r.item_code) ?? 0;
      const delta = a - b;
      const okDelta = delta === r.qty;
      note(`  ${String(r.item_code).padEnd(30)} on_hand ${b} -> ${a}  (delta +${delta}, expected +${r.qty})  ${okDelta ? 'OK' : 'WRONG'}`);
      if (!okDelta) problems.push(`${r.item_code}: stock delta +${delta}, expected +${r.qty}`);
    }

    // 2. The three canonical ADJUSTMENT rows must now exist, with the right qty
    //    at the right warehouse — the exact shape fn_reverse_do_out produces.
    const adj = await check`
      SELECT item_code, warehouse_id::text AS warehouse_id, qty::int AS qty, movement_type::text AS movement_type
        FROM scm.inventory_movements
       WHERE source_doc_type = 'ADJUSTMENT' AND source_doc_id = ${doId}::uuid
       ORDER BY item_code`;
    const adjShape = Array.isArray(adj) ? adj : [];
    note(`\n  ADJUSTMENT rows now tagging ${DO_DOCNO}: ${adjShape.length}`);
    for (const a of adjShape) note(`    ${String(a.item_code).padEnd(30)} ${a.movement_type} qty=${a.qty} wh=${a.warehouse_id}`);
    if (adjShape.length !== EXPECTED.length) problems.push(`${adjShape.length} ADJUSTMENT rows, expected ${EXPECTED.length}`);
    for (const r of resolved) {
      const row = adjShape.find((a) => a.item_code === r.item_code);
      if (!row) { problems.push(`no ADJUSTMENT row for ${r.item_code}`); continue; }
      if (row.qty !== r.qty) problems.push(`${r.item_code} ADJUSTMENT qty ${row.qty}, expected +${r.qty}`);
      if (row.warehouse_id !== WAREHOUSE) problems.push(`${r.item_code} ADJUSTMENT warehouse ${row.warehouse_id}, expected ${WAREHOUSE}`);
    }

    // 3. DO-005's OUT cost stamps must be zeroed (the canonical reversal did it).
    const [{ out_cost }] = await check`
      SELECT COALESCE(SUM(total_cost_sen), 0)::bigint AS out_cost
        FROM scm.inventory_movements
       WHERE source_doc_type = 'DO' AND source_doc_id = ${doId}::uuid AND movement_type = 'OUT'`;
    note(`\n  DO-005 OUT cost stamps now sum to ${out_cost} (expected 0).`);
    if (Number(out_cost) !== 0) problems.push(`DO-005 OUT cost stamps sum ${out_cost}, expected 0`);

    // 4. The genuine DO must be byte-for-byte unchanged.
    if (keepId) {
      const keepAfter = await movementShape(check, keepId);
      const same = JSON.stringify(keepBefore) === JSON.stringify(keepAfter);
      note(`\n  Genuine DO ${KEEP_DOCNO}: ${keepAfter.length} bucket(s), unchanged=${same}`);
      if (!same) problems.push(`${KEEP_DOCNO} movement shape changed — it must be untouched`);
    }

    if (problems.length) {
      note(`\n=== VERIFICATION FAILED ===`);
      for (const p of problems) bad(`  ${p}`);
      process.exit(1);
    }
    note(`\n=== DONE — stock restored: ${resolved.map((r) => `${r.key} +${r.qty}`).join(', ')}. ${KEEP_DOCNO} untouched. ===`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
