#!/usr/bin/env node
/* HC-0108 + the READY audit (Wei Siang, 2026-10-16): close the purchase-order
 * lines that data rounds left open, so they stop showing on the outstanding list
 * and the receipt-drift probe stops counting them.
 *
 * PART A - SOFA PIECES (HC-0108, the HC-0110 defect on three more POs).
 * apply-sofa-compartment-corrections (2026-09-10, run 34507126629) split each
 * collapsed AutoCount sofa line into one PO row per piece and INSERTed the new
 * piece at received 0 with no receipt line. The whole set was received as one
 * AutoCount line and every one of these sales orders is DELIVERED:
 *
 *   HC-PO-009630  5535-L(RHF) added; 5535-1A(LHF) received on HC-GR-005257-PO-009630
 *   HC-PO-009940  5535-1NA    added; 5535-1A(LHF) received on HC-GR-005329-PO-009940
 *   HC-PO-009718  9028-1A(RHF) added; 9028-1A(LHF) received in AutoCount only (no ERP
 *                 receipt), and HC-SO-012913's RHF line has no delivery-order line
 *
 * A clone piece takes a copy of its source's receipt line (every _sen column
 * zeroed, as HC-0110 did) and is recounted by the recomputePoReceived rule. The
 * AutoCount-only piece takes its source's stored count, and its SO line takes a
 * copy of the source's line on the migrated, delivered DO; both SO-012913 lines
 * are then marked READY, which is what delivery sync does to a delivered line.
 *
 * PART B - DOUBLED RECEIPTS. The 2026-08-28 receipt import put nine PO lines on
 * an unlinked receipt that the 2026-09-20 AutoCount-linked import received again
 * (ordered 1, received twice). The unlinked 08-28 LINE is removed; its receipt
 * keeps its other line, and the linked 09-20 receipt stays. The removed lines
 * carry no money, no invoice, no return, no stock movement and no AutoCount
 * outbox row, and nothing else references them (checked against every foreign
 * key that points at scm.grn_items).
 *
 * Each PO's status is re-derived from its stored lines afterwards
 * (poStatusFromLines - never on a CANCELLED or ON_HOLD PO). The decisions live
 * in lib/hc0108-repair-plan.mjs and are tested on the real rows
 * (tests/hc0108RepairPlan.test.mjs). Nothing is queued to AutoCount.
 *
 * MODE=plan (default) runs every write inside a transaction and ROLLS BACK, so
 * the plan log is the apply's exact effect. MODE=apply with
 * CONFIRM="I HAVE REVIEWED THE DRY-RUN" commits each document in its own
 * transaction, then re-reads on a FRESH connection and asserts the shape.
 *
 * RE-RUN: inert. A piece is selected only while it reads received 0 with no
 * receipt line, and a doubled line only while both receipts are on it; a
 * successful apply removes both conditions, so a second run refuses every item
 * as already done and writes nothing.
 */
import postgres from 'postgres';
import { buildCloneInsert } from './lib/redecode-sofa-plan.mjs';
import { poStatusFromLines } from './lib/po-received-recount.mjs';
import { planDoubled, planPiece, planPieceDelivery } from './lib/hc0108-repair-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const CO = 1;
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const ROLLBACK = Symbol('plan rollback');
const LIVE_GRN = ['CANCELLED', 'DRAFT'];

/* Read off production 2026-10-16 (diag-ready-audit-2026-10-16.mjs PART=4). */
const PIECES = [
  { po: 'HC-PO-009630', piece: '5535-L(RHF)', source: '5535-1A(LHF)' },
  { po: 'HC-PO-009940', piece: '5535-1NA', source: '5535-1A(LHF)' },
  { po: 'HC-PO-009718', piece: '9028-1A(RHF)', source: '9028-1A(LHF)', acOnly: true, so: 'HC-SO-012913' },
];
const DOUBLED = [
  { po: 'HC-PO-009431', item: 'CASUAL-(SS)', dup: 'HC-GR-005033-PO-009431', keep: 'HC-GR-005039-PO-009431' },
  { po: 'HC-PO-009557', item: 'TRION (A)-(K)', dup: 'HC-GR-005101-PO-009557', keep: 'HC-GR-005102-PO-009557' },
  { po: 'HC-PO-009680', item: 'HILTON (A)-(Q)', dup: 'HC-GR-005167-PO-009680', keep: 'HC-GR-005199-PO-009680' },
  { po: 'HC-PO-009791', item: 'JAGER-(K)', dup: 'HC-GR-005234-PO-009791', keep: 'HC-GR-005235-PO-009791' },
  { po: 'HC-PO-009820', item: 'TRION (A) (HB STR)-(K)', dup: 'HC-GR-005235-PO-009820', keep: 'HC-GR-005256-PO-009820' },
  { po: 'HC-PO-009824', item: 'FENRIR-(Q)', dup: 'HC-GR-005239-PO-009824', keep: 'HC-GR-005256-PO-009824' },
  { po: 'HC-PO-009847', item: 'DIVAN ONLY-(K)', dup: 'HC-GR-005270-PO-009847', keep: 'HC-GR-005278-PO-009847' },
  { po: 'HC-PO-009903', item: 'DIVAN ONLY-(Q)', dup: 'HC-GR-005278-PO-009903', keep: 'HC-GR-005304-PO-009903' },
  { po: 'HC-PO-009934', item: 'TRION (A) (HB STR)-(K)', dup: 'HC-GR-005271-PO-009934', keep: 'HC-GR-005282-PO-009934' },
];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function insertableColumns(client, table) {
  const rows = await client`
    SELECT column_name, is_generated, identity_generation
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}
     ORDER BY ordinal_position`;
  if (!rows.length) throw new Error(`scm.${table} has no columns in information_schema - wrong database?`);
  return rows.filter((r) => r.is_generated !== 'ALWAYS' && r.identity_generation === null).map((r) => r.column_name);
}

/** Every (table, column) whose foreign key points at scm.grn_items. */
async function grnItemReferrers(client) {
  return client`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'scm.grn_items'::regclass`;
}
async function refsTo(client, referrers, id) {
  let n = 0;
  for (const r of referrers) {
    const [{ c }] = await client.unsafe(`SELECT COUNT(*)::int AS c FROM ${r.tbl} WHERE "${r.col.replace(/"/g, '""')}" = $1::uuid`, [id]);
    n += c;
  }
  return n;
}
const movementsOf = async (client, id) => Number((await client`
  SELECT COUNT(*)::int AS n FROM scm.inventory_movements WHERE source_doc_id::text = ${id}`)[0].n);
const outboxOf = async (client, id, docNo) => Number((await client`
  SELECT COUNT(*)::int AS n FROM scm.autocount_outbox WHERE doc_id = ${id} OR doc_no = ${docNo}`)[0].n);

async function readPo(client, poNumber) {
  const [po] = await client`
    SELECT id::text AS id, po_number, status::text AS status, received_at
      FROM scm.purchase_orders WHERE po_number = ${poNumber} AND company_id = ${CO}`;
  if (!po) return null;
  const lines = (await client`
    SELECT id::text AS id, item_code, item_group, material_name, description, supplier_sku,
           qty::float8 AS qty, COALESCE(received_qty, 0)::float8 AS received_qty,
           COALESCE(unit_price_sen, 0)::bigint AS unit_price_sen, linked_ac_dtlkey::text AS dtlkey,
           so_item_id::text AS so_item_id
      FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id}::uuid`).map((l) => ({
    ...l, itemCode: l.item_code, receivedQty: l.received_qty, unitPriceSen: Number(l.unit_price_sen), soItemId: l.so_item_id,
  }));
  return { po, lines };
}
async function readGrnLines(client, poItemIds) {
  if (!poItemIds.length) return [];
  return (await client`
    SELECT gi.id::text AS id, gi.grn_id::text AS grn_id, gi.purchase_order_item_id::text AS poi,
           g.grn_number, g.status::text AS status, g.migrated_no_stock, g.linked_ac_gr_docno,
           to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_on,
           COALESCE(gi.qty_accepted, 0)::float8 AS qty_accepted, COALESCE(gi.returned_qty, 0)::float8 AS returned_qty,
           COALESCE(gi.invoiced_qty, 0)::float8 AS invoiced_qty, COALESCE(gi.line_total_sen, 0)::bigint AS line_total_sen
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE gi.purchase_order_item_id = ANY(${poItemIds}::uuid[])`).map((g) => ({
    id: g.id, grnId: g.grn_id, grnNumber: g.grn_number, poItemId: g.poi, status: g.status,
    migratedNoStock: g.migrated_no_stock, linkedAcGrDocno: g.linked_ac_gr_docno, createdOn: g.created_on,
    qtyAccepted: g.qty_accepted, returnedQty: g.returned_qty, invoicedQty: g.invoiced_qty,
    lineTotalSen: Number(g.line_total_sen), refs: 0,
  }));
}

/* recomputePoReceived's rule, for the lines given: live receipt lines, net of returns. */
async function recount(tx, poItemIds) {
  await tx`
    UPDATE scm.purchase_order_items i
       SET received_qty = (SELECT COALESCE(SUM(GREATEST(0, COALESCE(gi.qty_accepted,0) - COALESCE(gi.returned_qty,0))), 0)
                             FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                            WHERE gi.purchase_order_item_id = i.id AND g.status::text <> ALL(${LIVE_GRN}))
     WHERE i.id = ANY(${poItemIds}::uuid[])`;
}
/* Re-derive the PO status from its stored lines; returns 'from -> to' or null. */
async function resyncPoStatus(tx, poId) {
  const [po] = await tx`SELECT status::text AS status FROM scm.purchase_orders WHERE id = ${poId}::uuid`;
  const lines = await tx`SELECT qty::float8 AS qty, COALESCE(received_qty,0)::float8 AS received_qty
                           FROM scm.purchase_order_items WHERE purchase_order_id = ${poId}::uuid`;
  const next = poStatusFromLines(po.status, lines.map((l) => ({ qty: l.qty, receivedQty: l.received_qty })));
  if (!next || next === po.status) return null;
  await tx`
    UPDATE scm.purchase_orders
       SET status = ${next},
           received_at = CASE WHEN ${next} = 'RECEIVED' THEN COALESCE(received_at, now()) ELSE NULL END,
           updated_at = now()
     WHERE id = ${poId}::uuid AND status::text NOT IN ('CANCELLED', 'ON_HOLD')`;
  return `${po.status} -> ${next}`;
}
const poTotal = async (c, poId) => String((await c`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.purchase_order_items WHERE purchase_order_id = ${poId}::uuid`)[0].t);
const grnTotal = async (c, grnId) => String((await c`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.grn_items WHERE grn_id = ${grnId}::uuid`)[0].t);
const doTotal = async (c, doId) => String((await c`SELECT COALESCE(SUM(line_total_sen),0)::bigint t FROM scm.delivery_order_items WHERE delivery_order_id = ${doId}::uuid`)[0].t);

/* ── PART A ─────────────────────────────────────────────────────────────── */
async function planPieces() {
  const out = [];
  for (const e of PIECES) {
    const r = await readPo(sql, e.po);
    if (!r) { bad(`REFUSED ${e.po}: not found in company ${CO}`); continue; }
    const grns = await readGrnLines(sql, r.lines.map((l) => l.id));
    const p = planPiece(e, r.lines, grns);
    if (p.refused) { bad(`REFUSED ${p.refused}`); continue; }
    let delivery = null;
    if (p.mode === 'clone') {
      if (await movementsOf(sql, p.grnLine.grnId)) { bad(`REFUSED ${p.grnLine.grnNumber} carries inventory movements`); continue; }
    } else {
      const soIds = [p.piece.soItemId, p.source.soItemId].filter(Boolean);
      const soLines = (await sql`
        SELECT s.id::text AS id, s.doc_no, s.item_code, s.qty::float8 AS qty, s.cancelled, so.status::text AS so_status
          FROM scm.mfg_sales_order_items s JOIN scm.mfg_sales_orders so ON so.doc_no = s.doc_no
         WHERE s.id = ANY(${soIds}::uuid[])`).map((s) => ({ ...s, docNo: s.doc_no, itemCode: s.item_code }));
      const doLines = (await sql`
        SELECT di.id::text AS id, di.delivery_order_id::text AS do_id, di.so_item_id::text AS so_item_id,
               di.qty::float8 AS qty, d.do_number, d.status::text AS status, d.migrated_no_stock
          FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
         WHERE di.so_item_id = ANY(${soIds}::uuid[])`).map((d) => ({
        id: d.id, doId: d.do_id, doNumber: d.do_number, soItemId: d.so_item_id, qty: d.qty,
        status: d.status, migratedNoStock: d.migrated_no_stock,
      }));
      delivery = planPieceDelivery(e, p, soLines, doLines);
      if (delivery.refused) { bad(`REFUSED ${delivery.refused}`); continue; }
      if (soLines.some((s) => s.so_status !== 'DELIVERED')) { bad(`REFUSED ${e.so} is not DELIVERED`); continue; }
      if (await movementsOf(sql, delivery.doLine.doId)) { bad(`REFUSED ${delivery.doLine.doNumber} carries inventory movements`); continue; }
    }
    out.push({ e, po: r.po, plan: p, delivery });
    log('');
    log(`${e.po} (${r.po.status}) - ${e.piece} received 0 -> ${p.piece.qty}`
      + (p.mode === 'clone' ? `  (+1 line on ${p.grnLine.grnNumber}, RM 0, copied from ${e.source})` : `  (AutoCount-only, as ${e.source})`));
    if (delivery) log(`   ${e.so}: ${e.piece} +1 line on ${delivery.doLine.doNumber} (DELIVERED, migrated), RM 0; both lines READY`);
  }
  return out;
}

async function writePiece(tx, b, grnCols, doCols, grnHeaderCols) {
  const pick = (cols, o) => Object.fromEntries(Object.entries(o).filter(([c]) => cols.includes(c)));
  const varsOf = async (table, id) => (await tx.unsafe(`SELECT variants::text AS v FROM ${table} WHERE id = $1::uuid`, [id]))[0].v;
  const { piece, source } = b.plan;
  const before = { po: await poTotal(tx, b.po.id) };

  if (b.plan.mode === 'clone') {
    const g = b.plan.grnLine;
    if (await movementsOf(tx, g.grnId)) throw new Error(`${g.grnNumber} now carries inventory movements`);
    before.grn = await grnTotal(tx, g.grnId);
    const ins = buildCloneInsert({
      table: 'scm.grn_items', columns: grnCols,
      overrides: pick(grnCols, {
        purchase_order_item_id: 'uuid', item_code: null, item_group: null, material_name: null,
        description: null, supplier_sku: null, variants: 'text::jsonb',
      }),
    });
    const bind = {
      purchase_order_item_id: piece.id, item_code: piece.item_code, item_group: piece.item_group,
      material_name: piece.material_name, description: piece.description, supplier_sku: piece.supplier_sku,
      variants: await varsOf('scm.purchase_order_items', piece.id),
    };
    await tx.unsafe(ins.text, [g.id, ...ins.params.map((c) => bind[c])]);
    await recount(tx, [piece.id]);
    if (grnHeaderCols.includes('line_count')) {
      await tx`UPDATE scm.grns SET line_count = (SELECT COUNT(*) FROM scm.grn_items WHERE grn_id = ${g.grnId}::uuid) WHERE id = ${g.grnId}::uuid`;
    }
    if (await grnTotal(tx, g.grnId) !== before.grn) throw new Error(`${g.grnNumber} total moved`);
  } else {
    const n = await tx`
      UPDATE scm.purchase_order_items SET received_qty = ${source.receivedQty}
       WHERE id = ${piece.id}::uuid AND COALESCE(received_qty, 0) = 0 RETURNING id`;
    if (n.length !== 1) throw new Error(`${b.e.piece} was no longer at received 0`);
    const d = b.delivery.doLine;
    if (await movementsOf(tx, d.doId)) throw new Error(`${d.doNumber} now carries inventory movements`);
    before.do = await doTotal(tx, d.doId);
    const ins = buildCloneInsert({
      table: 'scm.delivery_order_items', columns: doCols,
      overrides: pick(doCols, { so_item_id: 'uuid', item_code: null, item_group: null, description: null, variants: 'text::jsonb' }),
    });
    const [s] = await tx`SELECT id::text AS id, item_code, item_group, description FROM scm.mfg_sales_order_items WHERE id = ${b.delivery.pieceSo.id}::uuid`;
    const bind = { so_item_id: s.id, item_code: s.item_code, item_group: s.item_group, description: s.description,
      variants: await varsOf('scm.mfg_sales_order_items', s.id) };
    await tx.unsafe(ins.text, [d.id, ...ins.params.map((c) => bind[c])]);
    const [{ n: count }] = await tx`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE delivery_order_id = ${d.doId}::uuid`;
    await tx`UPDATE scm.delivery_orders SET line_count = ${count} WHERE id = ${d.doId}::uuid`;
    if (await doTotal(tx, d.doId) !== before.do) throw new Error(`${d.doNumber} total moved`);
    await tx`
      UPDATE scm.mfg_sales_order_items SET stock_status = 'READY', stock_qty_ready = qty
       WHERE id = ANY(${[b.delivery.pieceSo.id, b.delivery.sourceSo.id]}::uuid[])`;
  }

  const [r] = await tx`SELECT qty::float8 q, received_qty::float8 r FROM scm.purchase_order_items WHERE id = ${piece.id}::uuid`;
  if (r.r !== r.q) throw new Error(`${b.e.piece} reads received ${r.r} of ${r.q} after the write`);
  if (await poTotal(tx, b.po.id) !== before.po) throw new Error(`${b.e.po} total moved`);
  return { before, status: await resyncPoStatus(tx, b.po.id) };
}

/* ── PART B ─────────────────────────────────────────────────────────────── */
async function planDoubles(referrers) {
  const out = [];
  for (const e of DOUBLED) {
    const r = await readPo(sql, e.po);
    if (!r) { bad(`REFUSED ${e.po}: not found in company ${CO}`); continue; }
    const matches = r.lines.filter((l) => l.item_code.trim().toUpperCase() === e.item.toUpperCase());
    if (matches.length !== 1) { bad(`REFUSED ${e.po}: ${matches.length} ${e.item} lines, expected 1`); continue; }
    const onLine = await readGrnLines(sql, [matches[0].id]);
    const dupGrnIds = [...new Set(onLine.filter((g) => g.grnNumber === e.dup).map((g) => g.grnId))];
    const others = dupGrnIds.length
      ? (await sql`SELECT id::text AS id, grn_id::text AS grn_id FROM scm.grn_items WHERE grn_id = ANY(${dupGrnIds}::uuid[])`)
        .filter((o) => !onLine.some((g) => g.id === o.id)).map((o) => ({ id: o.id, grnId: o.grn_id, poItemId: null, status: 'POSTED' }))
      : [];
    for (const g of onLine) if (g.grnNumber === e.dup) g.refs = await refsTo(sql, referrers, g.id);
    const d = planDoubled(e, matches[0], [...onLine, ...others]);
    if (d.refused) { bad(`REFUSED ${d.refused}`); continue; }
    const moves = await movementsOf(sql, d.remove.grnId);
    const outbox = await outboxOf(sql, d.remove.grnId, e.dup);
    if (moves || outbox) { bad(`REFUSED ${e.dup}: ${moves} movement(s), ${outbox} AutoCount outbox row(s)`); continue; }
    out.push({ e, po: r.po, line: matches[0], d });
    log(`${e.po} ${e.item.padEnd(24)} remove its line on ${e.dup}; keep ${e.keep} (${d.keep.linkedAcGrDocno})`);
  }
  return out;
}

async function writeDouble(tx, b, grnCols, referrers) {
  const g = b.d.remove;
  if (await refsTo(tx, referrers, g.id)) throw new Error(`${b.e.dup} ${b.e.item} gained a reference`);
  if (await movementsOf(tx, g.grnId)) throw new Error(`${b.e.dup} now carries inventory movements`);
  const before = { grn: await grnTotal(tx, g.grnId), po: await poTotal(tx, b.po.id) };
  const del = await tx`
    DELETE FROM scm.grn_items
     WHERE id = ${g.id}::uuid AND grn_id = ${g.grnId}::uuid AND COALESCE(invoiced_qty,0) = 0
       AND COALESCE(returned_qty,0) = 0 AND COALESCE(line_total_sen,0) = 0
    RETURNING id`;
  if (del.length !== 1) throw new Error(`${b.e.dup} ${b.e.item}: removed ${del.length} rows, expected 1`);
  if (grnCols.includes('line_count')) {
    await tx`UPDATE scm.grns SET line_count = (SELECT COUNT(*) FROM scm.grn_items WHERE grn_id = ${g.grnId}::uuid) WHERE id = ${g.grnId}::uuid`;
  }
  await recount(tx, [b.line.id]);
  const [r] = await tx`SELECT qty::float8 q, received_qty::float8 r FROM scm.purchase_order_items WHERE id = ${b.line.id}::uuid`;
  if (r.r !== r.q) throw new Error(`${b.e.po} ${b.e.item} recounts to ${r.r} of ${r.q}`);
  const [{ left }] = await tx`SELECT COUNT(*)::int AS left FROM scm.grn_items WHERE grn_id = ${g.grnId}::uuid`;
  if (left < 1) throw new Error(`${b.e.dup} was left empty`);
  if (await grnTotal(tx, g.grnId) !== before.grn) throw new Error(`${b.e.dup} total moved`);
  if (await poTotal(tx, b.po.id) !== before.po) throw new Error(`${b.e.po} total moved`);
  return { status: await resyncPoStatus(tx, b.po.id) };
}

async function rehearseOrApply(label, write) {
  try {
    const res = await sql.begin(async (tx) => {
      const out = await write(tx);
      if (!APPLY) throw Object.assign(new Error('rollback'), { rollback: ROLLBACK, out });
      return out;
    });
    log(`  OK ${label} - committed${res.status ? `; PO ${res.status}` : ''}`);
    return true;
  } catch (err) {
    if (err.rollback === ROLLBACK) {
      log(`  OK ${label} - rehearsal passed every check, rolled back${err.out?.status ? `; PO would go ${err.out.status}` : ''}`);
      return true;
    }
    bad(`  ROLLED BACK ${label} - ${err.message}`);
    return false;
  }
}

async function main() {
  log(`HC-0108 sofa pieces + doubled receipts - mode=${APPLY ? 'APPLY' : 'PLAN (rehearsed in a transaction, rolled back)'}`);
  const grnCols = await insertableColumns(sql, 'grn_items');
  const doCols = await insertableColumns(sql, 'delivery_order_items');
  const grnHeaderCols = await insertableColumns(sql, 'grns');
  const referrers = await grnItemReferrers(sql);
  log(`foreign keys pointing at scm.grn_items: ${referrers.map((r) => `${r.tbl}.${r.col}`).join(', ') || 'none'}`);

  log('');
  log('=== PART A - sofa pieces ===');
  const pieces = await planPieces();
  log('');
  log('=== PART B - doubled receipts ===');
  const doubles = await planDoubles(referrers);

  log('');
  log('=== WRITES ===');
  let ok = 0;
  for (const b of pieces) if (await rehearseOrApply(`${b.e.po} ${b.e.piece}`, (tx) => writePiece(tx, b, grnCols, doCols, grnHeaderCols))) ok++;
  for (const b of doubles) if (await rehearseOrApply(`${b.e.po} ${b.e.item}`, (tx) => writeDouble(tx, b, grnHeaderCols, referrers))) ok++;
  const expected = PIECES.length + DOUBLED.length;
  log(`planned ${pieces.length + doubles.length} of ${expected}; ${APPLY ? 'committed' : 'rehearsed'} ${ok}`);
  await sql.end({ timeout: 5 });

  if (!APPLY) {
    log('');
    log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    process.exit(ok === expected ? 0 : 1);
  }

  /* Only what this script touched: each piece and each doubled line now reads
     received in full from one live receipt, and its PO's status matches its
     stored lines. Other lines on these POs are not this repair's to judge. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let held = 0;
  try {
    log('');
    log('=== VERIFIED ON A FRESH CONNECTION ===');
    const items = [
      ...PIECES.map((e) => ({ po: e.po, code: e.piece, kind: e.acOnly ? 'ac-only' : 'clone' })),
      ...DOUBLED.map((e) => ({ po: e.po, code: e.item, kind: 'doubled' })),
    ];
    for (const it of items) {
      const r = await readPo(check, it.po);
      const lines = r.lines.filter((l) => l.item_code.trim().toUpperCase() === it.code.toUpperCase());
      const grns = await readGrnLines(check, lines.map((l) => l.id));
      const liveNet = (id) => grns.filter((g) => g.poItemId === id && !LIVE_GRN.includes(g.status.toUpperCase()))
        .reduce((s, g) => s + Math.max(0, g.qtyAccepted - g.returnedQty), 0);
      const want = poStatusFromLines(r.po.status, r.lines.map((l) => ({ qty: l.qty, receivedQty: l.receivedQty })));
      const lineOk = lines.length >= 1 && lines.every((l) => l.receivedQty === l.qty
        && (it.kind === 'ac-only' ? liveNet(l.id) === 0 : liveNet(l.id) === l.qty));
      const statusOk = want === null || want === r.po.status;
      const good = lineOk && statusOk;
      (good ? log : bad)(`  ${it.po} ${it.code}: received ${lines.map((l) => `${l.receivedQty}/${l.qty}`).join(', ')}, `
        + `receipts ${lines.map((l) => liveNet(l.id)).join(', ')}; PO ${r.po.status}${statusOk ? '' : ` (expected ${want})`}`);
      if (good) held++;
    }
    const [{ n: soReady }] = await check`
      SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE doc_no = 'HC-SO-012913' AND cancelled = false AND stock_status::text = 'READY'`;
    log(`  HC-SO-012913: ${soReady} line(s) READY`);
    log(`  items verified ${held} of ${items.length}`);
  } finally {
    await check.end({ timeout: 5 });
  }
  process.exit(held === PIECES.length + DOUBLED.length ? 0 : 1);
}

main().catch(async (e) => {
  bad(e.stack || e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
