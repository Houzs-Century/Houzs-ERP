#!/usr/bin/env node
/*
 READ-ONLY forensic check: PO lines whose received_qty exceeds the qty ordered,
 and whether that excess ever became STOCK.

 WHY. A system-wide sweep found 65 of 864 PO lines (7.5%) with
 received_qty > qty — 73 excess units — and the shape was suspicious: one GRN
 (HC-GR-004913) posting 2 against four different PO lines that each ordered 1.
 Not a sum across several GRNs, not sibling-line fan-out. Doubling dominated.

 The question that decides how much this matters is NOT "how many documents are
 wrong". It is "did the wrong number move stock". A GRN carrying
 migrated_no_stock = true is AutoCount paperwork mirrored into the ERP: the goods
 were already counted by the balance snapshot, so the document deliberately posts
 NO inventory movement (migration 0276). An inflated quantity on such a document
 is a wrong number on a piece of paper. The same inflation on a real posting is
 stock the company does not have.

 So this check computes both, separately, and never conflates them:
   §1  every over-received line, with its GRNs and each GRN's migrated flag
   §2  THE DECISIVE ONE — excess units that produced inventory movements vs
       excess that is document-only. Stock is overstated only by the first.
   §3  the migrated-vs-human split, which decides whether this is our import
       bug or a live application bug
   §4  HC-GR-004913 in full: header, every line, and the PO's lines, so the
       field carrying the 2 is named rather than inferred
   §5  the same-shaped check on the delivery side. The owner's model allows an
       order to be delivered in several batches, so the guard is the CEILING
       (Σ delivered per SO line > that line's qty), not "more than one DO".

 READ-ONLY: SELECTs only. No DDL, no writes, no transaction. Exits 0 always —
 this is a measurement, not a gate; the numbers are the output.
*/
import postgres from "postgres";
import { DO_SHIPPED_STATES } from "./lib/do-shipped-states.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m = "") => console.log(m);
const n = (v) => Number(v ?? 0);

async function main() {
  // ── §1 every over-received PO line, with the GRNs behind it ───────────────
  /* One row per (PO line × GRN that received against it). Aggregating the GRNs
     into an array on the line would hide the very thing being investigated —
     whether the excess sits inside ONE document or is spread across several. */
  const lines = await db`
    SELECT po.po_number,
           po.linked_ac_docno            AS ac_po,
           po.status::text               AS po_status,
           poi.id                        AS poi_id,
           poi.item_code,
           poi.qty::int                  AS ordered,
           COALESCE(poi.received_qty, 0)::int AS received,
           g.grn_number,
           g.status::text                AS grn_status,
           g.migrated_no_stock,
           g.id                          AS grn_id,
           COALESCE(gi.qty_received, 0)::int  AS gi_received,
           COALESCE(gi.qty_accepted, 0)::int  AS gi_accepted,
           COALESCE(gi.qty_rejected, 0)::int  AS gi_rejected,
           COALESCE(gi.returned_qty, 0)::int  AS gi_returned
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
      LEFT JOIN scm.grn_items gi   ON gi.purchase_order_item_id = poi.id
      LEFT JOIN scm.grns g         ON g.id = gi.grn_id
     WHERE COALESCE(poi.received_qty, 0) > poi.qty
     ORDER BY po.po_number, poi.item_code, g.grn_number`;

  const byLine = new Map();
  for (const r of lines) {
    if (!byLine.has(r.poi_id)) byLine.set(r.poi_id, { ...r, grns: [] });
    if (r.grn_number) byLine.get(r.poi_id).grns.push(r);
  }
  const all = [...byLine.values()];
  const excessOf = (l) => n(l.received) - n(l.ordered);
  const totalExcess = all.reduce((s, l) => s + excessOf(l), 0);

  log("═══ §1  OVER-RECEIVED PO LINES ═══");
  log(`lines with received_qty > qty: ${all.length}; excess units: ${totalExcess}`);
  log("");
  log("  PO            ITEM                     ORD  RCV  EXC  GRN(s)  [M]=migrated_no_stock");
  for (const l of all) {
    const grn = l.grns.length
      ? l.grns.map((g) => `${g.grn_number}${g.migrated_no_stock ? "[M]" : "[LIVE]"}(${g.grn_status},acc=${g.gi_accepted})`).join(" ")
      : "(NO GRN LINE AT ALL)";
    log(
      `  ${String(l.po_number).padEnd(13)} ${String(l.item_code).padEnd(24)} ` +
      `${String(l.ordered).padStart(3)} ${String(l.received).padStart(4)} ${String(excessOf(l)).padStart(4)}  ${grn}`,
    );
  }

  // ── §2 THE DECISIVE QUESTION: did the excess move stock? ──────────────────
  /* A GRN's stock effect is its IN rows in scm.inventory_movements, keyed by
     source_doc_type='GRN' + source_doc_id. inventory_balances is a VIEW over
     these movements, so on-hand is overstated by exactly the excess that
     appears HERE and nowhere else. Netted against any OUT written back against
     the same document (a cancellation reverses with an OUT). */
  const grnIds = [...new Set(all.flatMap((l) => l.grns.map((g) => g.grn_id)).filter(Boolean))];
  const moves = grnIds.length
    ? await db`
        SELECT m.source_doc_id AS grn_id,
               m.source_doc_no,
               m.item_code,
               SUM(CASE WHEN m.movement_type = 'IN'  THEN m.qty ELSE 0 END)::int AS in_qty,
               SUM(CASE WHEN m.movement_type = 'OUT' THEN m.qty ELSE 0 END)::int AS out_qty
          FROM scm.inventory_movements m
         WHERE m.source_doc_type = 'GRN'
           AND m.source_doc_id = ANY(${grnIds})
         GROUP BY m.source_doc_id, m.source_doc_no, m.item_code`
    : [];
  const moveBy = new Map();
  for (const m of moves) moveBy.set(`${m.grn_id}|${m.item_code}`, n(m.in_qty) - n(m.out_qty));

  let excessMoved = 0, excessPaperOnly = 0;
  const movedRows = [];
  for (const l of all) {
    const exc = excessOf(l);
    /* Attribute the excess to the GRNs that carry it. A line's excess "moved"
       only to the extent the documents behind it actually wrote IN rows. */
    const netIn = l.grns.reduce((s, g) => s + (moveBy.get(`${g.grn_id}|${l.item_code}`) ?? 0), 0);
    const movedExcess = Math.max(0, Math.min(exc, netIn - n(l.ordered)));
    if (movedExcess > 0) { excessMoved += movedExcess; movedRows.push({ l, netIn, movedExcess }); }
    excessPaperOnly += exc - movedExcess;
  }

  log("");
  log("═══ §2  DID THE EXCESS MOVE STOCK? ═══");
  log(`  GRNs behind these lines: ${grnIds.length}`);
  log(`  of those, GRNs with ANY inventory movement: ${new Set(moves.map((m) => m.grn_id)).size}`);
  log("");
  log(`  excess units TOTAL                      : ${totalExcess}`);
  log(`  excess units that MOVED STOCK           : ${excessMoved}   <-- on-hand overstated by this`);
  log(`  excess units that are DOCUMENT-ONLY     : ${excessPaperOnly}`);
  if (movedRows.length) {
    log("");
    log("  lines whose excess reached the ledger:");
    for (const r of movedRows) {
      log(`    ${r.l.po_number} ${r.l.item_code} ord=${r.l.ordered} rcv=${r.l.received} netIN=${r.netIn} movedExcess=${r.movedExcess}`);
    }
  }

  /* POSITIVE CONTROL. "0 movements" above is only evidence if this same query
     CAN find movements — otherwise a broken join reads exactly like a clean
     result. So run it against the GRNs that are NOT migrated and show it comes
     back non-zero. If the control is 0 too, the instrument is broken and §2
     means nothing; say so rather than reporting a false all-clear. */
  const [ctl] = await db`
    SELECT COUNT(DISTINCT g.id)::int                                    AS live_grns,
           COUNT(DISTINCT m.source_doc_id)::int                         AS live_grns_with_movements,
           COALESCE(SUM(CASE WHEN m.movement_type = 'IN' THEN m.qty ELSE 0 END), 0)::int AS live_in_units
      FROM scm.grns g
      LEFT JOIN scm.inventory_movements m
             ON m.source_doc_type = 'GRN' AND m.source_doc_id = g.id
     WHERE g.migrated_no_stock = false
       AND UPPER(COALESCE(g.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')`;
  const [mig] = await db`
    SELECT COUNT(DISTINCT g.id)::int            AS migrated_grns,
           COUNT(DISTINCT m.source_doc_id)::int AS migrated_grns_with_movements
      FROM scm.grns g
      LEFT JOIN scm.inventory_movements m
             ON m.source_doc_type = 'GRN' AND m.source_doc_id = g.id
     WHERE g.migrated_no_stock = true`;
  log("");
  log("  -- positive control (is the movement query actually capable of finding rows?) --");
  log(`    NON-migrated posted GRNs: ${ctl.live_grns}; of those WITH movements: ${ctl.live_grns_with_movements} (${ctl.live_in_units} IN units)`);
  log(`    migrated GRNs system-wide: ${mig.migrated_grns}; of those WITH movements: ${mig.migrated_grns_with_movements} (must be 0 by design, migration 0276)`);
  if (n(ctl.live_grns_with_movements) === 0) {
    log("    !! CONTROL FAILED — the query found no movements ANYWHERE. §2's zero is not evidence.");
  } else {
    log("    control passes: the query finds movements where movements exist, so §2's zero is real.");
  }

  // ── §3 migrated import vs human posting ──────────────────────────────────
  /* Which code wrote these documents decides what to fix. migrated_no_stock is
     set only by create-migrated-documents.mjs; a GRN without it went through
     the application's own posting path. */
  let migLines = 0, liveLines = 0, mixedLines = 0, noGrnLines = 0;
  let migExcess = 0, liveExcess = 0, mixedExcess = 0, noGrnExcess = 0;
  for (const l of all) {
    const exc = excessOf(l);
    if (!l.grns.length) { noGrnLines++; noGrnExcess += exc; continue; }
    const mig = l.grns.filter((g) => g.migrated_no_stock).length;
    if (mig === l.grns.length) { migLines++; migExcess += exc; }
    else if (mig === 0) { liveLines++; liveExcess += exc; }
    else { mixedLines++; mixedExcess += exc; }
  }
  log("");
  log("═══ §3  MIGRATED IMPORT  vs  HUMAN-POSTED ═══");
  log(`  all GRNs migrated_no_stock=true : ${migLines} lines, ${migExcess} excess units`);
  log(`  all GRNs live postings          : ${liveLines} lines, ${liveExcess} excess units`);
  log(`  mixed migrated + live           : ${mixedLines} lines, ${mixedExcess} excess units`);
  log(`  no GRN line at all              : ${noGrnLines} lines, ${noGrnExcess} excess units`);

  // ── §4 HC-GR-004913 in full ──────────────────────────────────────────────
  const TARGET = process.env.GRN_NO || "HC-GR-004913";
  log("");
  log(`═══ §4  ${TARGET} — HEADER, LINES, AND THE PO ═══`);
  const [hdr] = await db`
    SELECT g.id, g.grn_number, g.status::text AS status, g.migrated_no_stock, g.linked_ac_docno,
           g.posted_at, g.received_at, g.created_by, g.company_id, g.purchase_order_id, g.notes
      FROM scm.grns g
     WHERE g.grn_number = ${TARGET}`;
  if (!hdr) {
    log(`  (no GRN numbered ${TARGET})`);
  } else {
    log(`  id=${hdr.id}`);
    log(`  status=${hdr.status}  migrated_no_stock=${hdr.migrated_no_stock}  linked_ac_docno=${hdr.linked_ac_docno}`);
    log(`  posted_at=${hdr.posted_at}  received_at=${hdr.received_at}  created_by=${hdr.created_by}`);
    log(`  notes: ${hdr.notes ?? "(none)"}`);
    const gl = await db`
      SELECT gi.item_code, gi.material_name,
             COALESCE(gi.qty_received, 0)::int AS qty_received,
             COALESCE(gi.qty_accepted, 0)::int AS qty_accepted,
             COALESCE(gi.qty_rejected, 0)::int AS qty_rejected,
             COALESCE(gi.returned_qty, 0)::int AS returned_qty,
             gi.purchase_order_item_id
        FROM scm.grn_items gi
       WHERE gi.grn_id = ${hdr.id}
       ORDER BY gi.item_code`;
    log("");
    log("  GRN LINES:   qty_received / qty_accepted / qty_rejected / returned_qty");
    for (const r of gl) {
      log(`    ${String(r.item_code).padEnd(24)} recv=${r.qty_received}  acc=${r.qty_accepted}  rej=${r.qty_rejected}  ret=${r.returned_qty}`);
    }
    const pl = await db`
      SELECT poi.item_code, poi.qty::int AS ordered,
             COALESCE(poi.received_qty, 0)::int AS received, poi.supplier_sku, poi.description2
        FROM scm.purchase_order_items poi
       WHERE poi.purchase_order_id = ${hdr.purchase_order_id}
       ORDER BY poi.item_code`;
    log("");
    log("  PO LINES on the same purchase order:");
    for (const r of pl) {
      log(`    ${String(r.item_code).padEnd(24)} ordered=${r.ordered}  received_qty=${r.received}  sku=${r.supplier_sku ?? "-"}`);
    }
    const mv = await db`
      SELECT movement_type::text AS t, item_code, SUM(qty)::int AS qty
        FROM scm.inventory_movements
       WHERE source_doc_type = 'GRN' AND source_doc_id = ${hdr.id}
       GROUP BY movement_type, item_code ORDER BY item_code`;
    log("");
    log(`  INVENTORY MOVEMENTS for this GRN: ${mv.length === 0 ? "NONE" : ""}`);
    for (const r of mv) log(`    ${r.t} ${r.item_code} qty=${r.qty}`);
  }

  // ── §5 the same shape on the delivery side ───────────────────────────────
  /* CEILING, not a one-shot flag: the owner's model allows an order line to be
     delivered in several batches, so several DOs against one SO line is normal.
     What is never allowed is the SUM exceeding what the line ordered. Cancelled
     DOs have had their effect reversed and are excluded, mirroring the PO side's
     treatment of cancelled GRNs. */
  const over = await db`
    WITH shipped AS (
      SELECT di.so_item_id,
             SUM(di.qty)::int AS delivered,
             COUNT(DISTINCT d.id)::int AS do_count,
             bool_or(d.migrated_no_stock) AS any_migrated,
             bool_and(d.migrated_no_stock) AS all_migrated
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE di.so_item_id IS NOT NULL
         AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
       GROUP BY di.so_item_id
    )
    SELECT soi.doc_no, soi.item_code, soi.qty::int AS ordered,
           s.delivered, s.do_count, s.any_migrated, s.all_migrated
      FROM shipped s
      JOIN scm.mfg_sales_order_items soi ON soi.id = s.so_item_id
     WHERE s.delivered > soi.qty
     ORDER BY (s.delivered - soi.qty) DESC, soi.doc_no`;

  const [{ tot: soLinesShipped }] = await db`
    SELECT COUNT(DISTINCT di.so_item_id)::int AS tot
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'`;

  log("");
  log("═══ §5  DELIVERY SIDE — Σ delivered > SO line ordered (CEILING) ═══");
  log(`  SO lines with any delivery: ${soLinesShipped}`);
  log(`  SO lines OVER-DELIVERED   : ${over.length}`);
  const overUnits = over.reduce((s, r) => s + (n(r.delivered) - n(r.ordered)), 0);
  log(`  excess delivered units    : ${overUnits}`);
  const migAll = over.filter((r) => r.all_migrated).length;
  const migNone = over.filter((r) => !r.any_migrated).length;
  log(`  of those: all-migrated DOs ${migAll}; no migrated DO ${migNone}; mixed ${over.length - migAll - migNone}`);
  for (const r of over.slice(0, 40)) {
    log(`    ${String(r.doc_no).padEnd(16)} ${String(r.item_code).padEnd(24)} ord=${r.ordered} delivered=${r.delivered} DOs=${r.do_count} allMigrated=${r.all_migrated}`);
  }
  if (over.length > 40) log(`    ... and ${over.length - 40} more`);

  /* Independent of the SO-line ceiling: a DO line with NO so_item_id cannot be
     ceiling-checked at all. That blindness is what let the SO-2606-019 double
     ship stay invisible, so it gets counted rather than assumed absent. */
  const [{ orphan }] = await db`
    SELECT COUNT(*)::int AS orphan
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NULL AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'`;
  log(`  DO lines with NULL so_item_id (invisible to the ceiling): ${orphan}`);

  /* Same decisive question on the delivery side. An over-delivery that posted
     OUT movements would UNDER-state on-hand (stock shipped out twice); one on a
     migrated_no_stock DO is again only paperwork. Positive control included for
     the same reason as §2. */
  const [doMv] = await db`
    SELECT COUNT(DISTINCT d.id)::int            AS migrated_dos,
           COUNT(DISTINCT m.source_doc_id)::int AS migrated_dos_with_movements
      FROM scm.delivery_orders d
      LEFT JOIN scm.inventory_movements m
             ON m.source_doc_type = 'DO' AND m.source_doc_id = d.id
     WHERE d.migrated_no_stock = true`;
  const [doCtl] = await db`
    SELECT COUNT(DISTINCT d.id)::int            AS live_dos,
           COUNT(DISTINCT m.source_doc_id)::int AS live_dos_with_movements
      FROM scm.delivery_orders d
      LEFT JOIN scm.inventory_movements m
             ON m.source_doc_type = 'DO' AND m.source_doc_id = d.id
     WHERE d.migrated_no_stock = false
       AND UPPER(COALESCE(d.status::text, '')) = ANY(${DO_SHIPPED_STATES})`;
  log("");
  log("  -- did the delivery side move stock? --");
  log(`    migrated DOs: ${doMv.migrated_dos}; of those WITH movements: ${doMv.migrated_dos_with_movements} (must be 0 by design)`);
  log(`    control — shipped NON-migrated DOs: ${doCtl.live_dos}; of those WITH movements: ${doCtl.live_dos_with_movements}`);

  return 0;
}

let code = 2;
try {
  code = await main();
} catch (e) {
  console.error("check failed:", e);
  code = 2;
} finally {
  await db.end({ timeout: 5 });
}
process.exit(code);
