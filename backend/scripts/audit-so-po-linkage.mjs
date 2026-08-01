// Read-only census: how much SO <-> PO/GRN/PI <-> DO cross-linkage actually
// EXISTS in production for company 2990, and what evidence survives that a
// reconstruction could be derived from.
//
// WHY (owner report 2026-08-01): the SCM lists show a dash in "ASSIGNED SO" and
// "DELIVERED" for many historical 2990 documents (e.g. 2990-PO-2606-001/-002,
// 2990-GRN-2607-029/028/024/021). The owner states the relationship DID exist
// operationally - every DO could be traced back to the PO its goods came from,
// and every PO forward to the SO it was raised for. The question this answers is
// narrow and factual: is the linkage data PRESENT but unresolved, or ABSENT?
//
// /po-so-coverage resolves "Assigned SO" in three layers (see
// backend/src/scm/routes/po-so-coverage.ts):
//   (a) delivered DO-lock  - inventory_movements.batch_no / inventory_lots.batch_no
//                            = PO number, consumed by a DO, then DO -> SO
//   (b) stored origin      - purchase_order_items.so_item_id, or the PO's
//                            "From SOs: ..." note
//   (c) MRP floating       - a live allocation guess, no stored fact
// This script counts (a) and (b) per document type and per month, so the split
// between "has a stored link", "has movement evidence only", and "nothing at
// all" is visible, and so the month the linking write-path started is visible as
// a step change in the numbers.
//
// SELECTs only. No INSERT / UPDATE / DELETE / DDL, no transaction. Exits 0 for
// every legitimate answer (per CLAUDE.md: a red job reads as "the check broke");
// non-zero only when the database is unreachable.
//
// No customer PII is printed: no debtor names, no addresses, no contacts. Only
// document numbers, SKU codes, quantities and dates.
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
  console.error("Need DATABASE_URL.");
  process.exit(2);
}

const COMPANY_ID = Number(process.env.COMPANY_ID ?? 2);
const FOCUS_SO = process.env.FOCUS_SO ?? "2990-SO-2607-028";

const out = (msg) => console.log(msg);
const head = (title) => {
  out("");
  out(`=== ${title} ${"=".repeat(Math.max(0, 68 - title.length))}`);
};
/* Every section is independently fail-soft: a missing table or a renamed column
   must degrade to "could not read X", never abort the other 11 answers. */
async function section(title, fn) {
  head(title);
  try {
    await fn();
  } catch (e) {
    out(`  READ FAILED: ${e.message}`);
  }
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  out(`company_id=${COMPANY_ID}  focus_so=${FOCUS_SO}`);

  await section("0. Company + document volumes", async () => {
    const co = await pg`
      SELECT id, name FROM public.companies WHERE id = ${COMPANY_ID}`.catch(() => []);
    if (co.length) out(`  company: ${co[0].id} = ${co[0].name}`);
    const vols = await pg`
      SELECT 'purchase_orders' AS t, count(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'purchase_order_items', count(*)::int FROM scm.purchase_order_items WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'grns', count(*)::int FROM scm.grns WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'purchase_invoices', count(*)::int FROM scm.purchase_invoices WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'mfg_sales_orders', count(*)::int FROM scm.mfg_sales_orders WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'mfg_sales_order_items', count(*)::int FROM scm.mfg_sales_order_items WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'delivery_orders', count(*)::int FROM scm.delivery_orders WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'delivery_order_items', count(*)::int FROM scm.delivery_order_items WHERE company_id = ${COMPANY_ID}
      UNION ALL SELECT 'sales_invoices', count(*)::int FROM scm.sales_invoices WHERE company_id = ${COMPANY_ID}`;
    for (const r of vols) out(`  ${r.t.padEnd(24)} ${r.n}`);
  });

  // ── Layer (b): stored origin ────────────────────────────────────────────
  await section("1. PO stored link (b): purchase_order_items.so_item_id", async () => {
    const r = await pg`
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE so_item_id IS NOT NULL)::int AS linked,
             count(DISTINCT purchase_order_id)::int AS pos,
             count(DISTINCT purchase_order_id) FILTER (WHERE so_item_id IS NOT NULL)::int AS pos_linked
      FROM scm.purchase_order_items WHERE company_id = ${COMPANY_ID}`;
    const x = r[0];
    out(`  PO lines: ${x.lines}   with so_item_id: ${x.linked}   (${pct(x.linked, x.lines)})`);
    out(`  POs:      ${x.pos}     with >=1 linked line: ${x.pos_linked}   (${pct(x.pos_linked, x.pos)})`);
    const note = await pg`
      SELECT count(*)::int AS n FROM scm.purchase_orders
      WHERE company_id = ${COMPANY_ID} AND notes ILIKE '%From SOs%'`;
    out(`  POs carrying a "From SOs:" note: ${note[0].n}`);
    const first = await pg`
      SELECT min(po.po_date)::text AS first_dt, max(po.po_date)::text AS last_dt
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders po ON po.id = i.purchase_order_id
      WHERE i.company_id = ${COMPANY_ID} AND i.so_item_id IS NOT NULL`;
    out(`  earliest / latest po_date carrying a stored so_item_id: ${first[0].first_dt ?? "(none)"} .. ${first[0].last_dt ?? "(none)"}`);
    const soLink = await pg`
      SELECT count(*)::int AS n FROM scm.purchase_order_items i
      WHERE i.company_id = ${COMPANY_ID} AND i.so_item_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_order_items s WHERE s.id = i.so_item_id)`;
    out(`  DANGLING so_item_id (points at no SO line): ${soLink[0].n}`);
  });

  // ── Layer (a): delivered DO-lock evidence ───────────────────────────────
  await section("2. Movement evidence (a): batch_no = PO number", async () => {
    const m = await pg`
      SELECT count(*)::int AS movs,
             count(DISTINCT batch_no)::int AS batches
      FROM scm.inventory_movements
      WHERE company_id = ${COMPANY_ID} AND batch_no IS NOT NULL`;
    out(`  inventory_movements with a batch_no: ${m[0].movs} rows, ${m[0].batches} distinct batches`);
    const mdo = await pg`
      SELECT count(*)::int AS n, count(DISTINCT batch_no)::int AS b
      FROM scm.inventory_movements
      WHERE company_id = ${COMPANY_ID} AND batch_no IS NOT NULL
        AND source_doc_type = 'DO' AND movement_type = 'OUT'`;
    out(`  ... of which DO/OUT (the drop-ship lock): ${mdo[0].n} rows, ${mdo[0].b} batches`);
    const lots = await pg`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE batch_no IS NOT NULL)::int AS batched
      FROM scm.inventory_lots WHERE company_id = ${COMPANY_ID}`;
    out(`  inventory_lots: ${lots[0].n} total, ${lots[0].batched} carry a batch_no (${pct(lots[0].batched, lots[0].n)})`);
    const cons = await pg`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE l.batch_no IS NOT NULL)::int AS from_batched
      FROM scm.inventory_lot_consumptions cc
      JOIN scm.inventory_lots l ON l.id = cc.lot_id
      WHERE cc.company_id = ${COMPANY_ID} AND cc.source_doc_type = 'DO'`;
    out(`  DO lot consumptions: ${cons[0].n}, of which from a BATCHED lot: ${cons[0].from_batched} (${pct(cons[0].from_batched, cons[0].n)})`);
    const match = await pg`
      SELECT count(DISTINCT po.id)::int AS n
      FROM scm.purchase_orders po
      WHERE po.company_id = ${COMPANY_ID} AND (
        EXISTS (SELECT 1 FROM scm.inventory_movements m
                 WHERE m.batch_no = po.po_number AND m.source_doc_type = 'DO' AND m.movement_type = 'OUT')
        OR EXISTS (SELECT 1 FROM scm.inventory_lots l
                    JOIN scm.inventory_lot_consumptions cc ON cc.lot_id = l.id AND cc.source_doc_type = 'DO'
                   WHERE l.batch_no = po.po_number))`;
    out(`  POs whose goods are traceable to a DO via batch_no: ${match[0].n}`);
    const anyLot = await pg`
      SELECT count(DISTINCT po.id)::int AS n FROM scm.purchase_orders po
      WHERE po.company_id = ${COMPANY_ID}
        AND EXISTS (SELECT 1 FROM scm.inventory_lots l WHERE l.batch_no = po.po_number)`;
    out(`  POs that ever produced a batch-stamped LOT (received at all): ${anyLot[0].n}`);
    const committed = await pg`
      SELECT count(*) FILTER (WHERE committed_po_batch_no IS NOT NULL)::int AS n, count(*)::int AS total
      FROM scm.delivery_order_items WHERE company_id = ${COMPANY_ID}`.catch(() => [{ n: "n/a", total: "n/a" }]);
    out(`  DO lines with committed_po_batch_no (mig 0230, ship-before-arrival): ${committed[0].n} / ${committed[0].total}`);
  });

  // ── The headline census: per document type, per month ───────────────────
  await section("3. PO census per month: stored link vs movement evidence vs nothing", async () => {
    const rows = await pg`
      WITH po AS (
        SELECT p.id, p.po_number, p.po_date, p.status,
               to_char(p.po_date, 'YYYY-MM') AS ym,
               EXISTS (SELECT 1 FROM scm.purchase_order_items i
                        WHERE i.purchase_order_id = p.id AND i.so_item_id IS NOT NULL) AS stored,
               (p.notes ILIKE '%From SOs%') AS note,
               EXISTS (SELECT 1 FROM scm.inventory_movements m
                        WHERE m.batch_no = p.po_number AND m.source_doc_type = 'DO' AND m.movement_type = 'OUT')
               OR EXISTS (SELECT 1 FROM scm.inventory_lots l
                           JOIN scm.inventory_lot_consumptions cc ON cc.lot_id = l.id AND cc.source_doc_type = 'DO'
                          WHERE l.batch_no = p.po_number) AS moved
        FROM scm.purchase_orders p WHERE p.company_id = ${COMPANY_ID}
      )
      SELECT ym, count(*)::int AS pos,
             count(*) FILTER (WHERE stored)::int AS stored,
             count(*) FILTER (WHERE note)::int AS note,
             count(*) FILTER (WHERE moved)::int AS moved,
             count(*) FILTER (WHERE NOT stored AND NOT note AND NOT moved)::int AS nothing
      FROM po GROUP BY ym ORDER BY ym`;
    out("  month     POs  stored  note  delivered-evidence  NOTHING");
    let t = { pos: 0, stored: 0, note: 0, moved: 0, nothing: 0 };
    for (const r of rows) {
      out(`  ${(r.ym ?? "(no date)").padEnd(9)} ${String(r.pos).padStart(4)} ${String(r.stored).padStart(7)} ${String(r.note).padStart(5)} ${String(r.moved).padStart(19)} ${String(r.nothing).padStart(8)}`);
      t.pos += r.pos; t.stored += r.stored; t.note += r.note; t.moved += r.moved; t.nothing += r.nothing;
    }
    out(`  ${"TOTAL".padEnd(9)} ${String(t.pos).padStart(4)} ${String(t.stored).padStart(7)} ${String(t.note).padStart(5)} ${String(t.moved).padStart(19)} ${String(t.nothing).padStart(8)}`);
  });

  await section("4. GRN census: does the parent PO carry any linkage?", async () => {
    const rows = await pg`
      WITH g AS (
        SELECT g.id, g.grn_number, to_char(g.received_at, 'YYYY-MM') AS ym,
               g.purchase_order_id IS NULL AS orphan,
               COALESCE(EXISTS (SELECT 1 FROM scm.purchase_order_items i
                        WHERE i.purchase_order_id = g.purchase_order_id AND i.so_item_id IS NOT NULL), false) AS stored,
               COALESCE((SELECT p.notes ILIKE '%From SOs%' FROM scm.purchase_orders p WHERE p.id = g.purchase_order_id), false) AS note,
               COALESCE((SELECT EXISTS (SELECT 1 FROM scm.inventory_movements m
                                 WHERE m.batch_no = p.po_number AND m.source_doc_type='DO' AND m.movement_type='OUT')
                             OR EXISTS (SELECT 1 FROM scm.inventory_lots l
                                         JOIN scm.inventory_lot_consumptions cc ON cc.lot_id=l.id AND cc.source_doc_type='DO'
                                        WHERE l.batch_no = p.po_number)
                         FROM scm.purchase_orders p WHERE p.id = g.purchase_order_id), false) AS moved
        FROM scm.grns g WHERE g.company_id = ${COMPANY_ID}
      )
      SELECT ym, count(*)::int AS grns,
             count(*) FILTER (WHERE orphan)::int AS no_po,
             count(*) FILTER (WHERE stored)::int AS stored,
             count(*) FILTER (WHERE note)::int AS note,
             count(*) FILTER (WHERE moved)::int AS moved,
             count(*) FILTER (WHERE NOT stored AND NOT note AND NOT moved)::int AS nothing
      FROM g GROUP BY ym ORDER BY ym`;
    out("  month     GRNs  no-PO  stored  note  delivered-evidence  NOTHING");
    for (const r of rows) {
      out(`  ${(r.ym ?? "(no date)").padEnd(9)} ${String(r.grns).padStart(4)} ${String(r.no_po).padStart(6)} ${String(r.stored).padStart(7)} ${String(r.note).padStart(5)} ${String(r.moved).padStart(19)} ${String(r.nothing).padStart(8)}`);
    }
  });

  await section("5. PI census: PI -> GRN -> PO chain integrity", async () => {
    const r = await pg`
      SELECT count(*)::int AS pis,
             count(*) FILTER (WHERE grn_id IS NULL)::int AS no_grn
      FROM scm.purchase_invoices WHERE company_id = ${COMPANY_ID}`;
    out(`  purchase_invoices: ${r[0].pis}, of which NO grn_id (manual PI, unlinkable): ${r[0].no_grn}`);
    const rows = await pg`
      WITH pi AS (
        SELECT pi.id, to_char(pi.invoice_date, 'YYYY-MM') AS ym,
               p.id AS po_id, p.po_number,
               COALESCE(EXISTS (SELECT 1 FROM scm.purchase_order_items i
                        WHERE i.purchase_order_id = p.id AND i.so_item_id IS NOT NULL), false) AS stored,
               COALESCE(p.notes ILIKE '%From SOs%', false) AS note,
               COALESCE(EXISTS (SELECT 1 FROM scm.inventory_movements m
                        WHERE m.batch_no = p.po_number AND m.source_doc_type='DO' AND m.movement_type='OUT')
                     OR EXISTS (SELECT 1 FROM scm.inventory_lots l
                                 JOIN scm.inventory_lot_consumptions cc ON cc.lot_id=l.id AND cc.source_doc_type='DO'
                                WHERE l.batch_no = p.po_number), false) AS moved
        FROM scm.purchase_invoices pi
        LEFT JOIN scm.grns g ON g.id = pi.grn_id
        LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
        WHERE pi.company_id = ${COMPANY_ID}
      )
      SELECT ym, count(*)::int AS pis,
             count(*) FILTER (WHERE po_id IS NULL)::int AS no_po,
             count(*) FILTER (WHERE stored)::int AS stored,
             count(*) FILTER (WHERE note)::int AS note,
             count(*) FILTER (WHERE moved)::int AS moved,
             count(*) FILTER (WHERE NOT stored AND NOT note AND NOT moved)::int AS nothing
      FROM pi GROUP BY ym ORDER BY ym`;
    out("  month     PIs  no-PO  stored  note  delivered-evidence  NOTHING");
    for (const r2 of rows) {
      out(`  ${(r2.ym ?? "(no date)").padEnd(9)} ${String(r2.pis).padStart(4)} ${String(r2.no_po).padStart(6)} ${String(r2.stored).padStart(7)} ${String(r2.note).padStart(5)} ${String(r2.moved).padStart(19)} ${String(r2.nothing).padStart(8)}`);
    }
  });

  // ── The reverse direction the owner also asks for: DO/SI -> source PO ────
  await section("6. DO side: does a DO know its SO, and can it reach a source PO?", async () => {
    const r = await pg`
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE so_item_id IS NOT NULL)::int AS with_so_item
      FROM scm.delivery_order_items WHERE company_id = ${COMPANY_ID}`;
    out(`  DO lines: ${r[0].lines}, with so_item_id: ${r[0].with_so_item} (${pct(r[0].with_so_item, r[0].lines)})`);
    const h = await pg`
      SELECT count(*)::int AS dos,
             count(*) FILTER (WHERE so_doc_no IS NOT NULL AND so_doc_no <> '')::int AS with_so
      FROM scm.delivery_orders WHERE company_id = ${COMPANY_ID}`;
    out(`  DO headers: ${h[0].dos}, with so_doc_no: ${h[0].with_so}  (${pct(h[0].with_so, h[0].dos)})`);
    const src = await pg`
      WITH d AS (
        SELECT d.id,
               EXISTS (SELECT 1 FROM scm.inventory_movements m
                        WHERE m.source_doc_id = d.id AND m.source_doc_type='DO'
                          AND m.movement_type='OUT' AND m.batch_no IS NOT NULL) AS mov_batch,
               EXISTS (SELECT 1 FROM scm.inventory_lot_consumptions cc
                        JOIN scm.inventory_lots l ON l.id = cc.lot_id
                       WHERE cc.source_doc_id = d.id AND cc.source_doc_type='DO'
                         AND l.batch_no IS NOT NULL) AS lot_batch,
               EXISTS (SELECT 1 FROM scm.inventory_movements m
                        WHERE m.source_doc_id = d.id AND m.source_doc_type='DO'
                          AND m.movement_type='OUT') AS any_out
        FROM scm.delivery_orders d
        WHERE d.company_id = ${COMPANY_ID} AND d.status::text <> 'CANCELLED'
      )
      SELECT count(*)::int AS dos,
             count(*) FILTER (WHERE any_out)::int AS shipped,
             count(*) FILTER (WHERE mov_batch OR lot_batch)::int AS source_po_traceable,
             count(*) FILTER (WHERE any_out AND NOT mov_batch AND NOT lot_batch)::int AS shipped_untraceable
      FROM d`;
    const s = src[0];
    out(`  non-cancelled DOs: ${s.dos}; with an OUT movement (actually shipped): ${s.shipped}`);
    out(`  ... source PO traceable via batch_no: ${s.source_po_traceable} (${pct(s.source_po_traceable, s.shipped)} of shipped)`);
    out(`  ... shipped but NO batch anywhere (source PO unknowable): ${s.shipped_untraceable}`);
    const bad = await pg`
      SELECT count(*)::int AS n FROM scm.inventory_lots l
      WHERE l.company_id = ${COMPANY_ID} AND l.batch_no IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM scm.purchase_orders p
                         WHERE p.company_id = ${COMPANY_ID} AND p.po_number = l.batch_no)`;
    out(`  batched lots whose batch_no is NOT a company PO number (free-text batch): ${bad[0].n}`);
  });

  await section("7. Where a batched lot came from: GRN linkage of the stamp", async () => {
    const r = await pg`
      SELECT source_doc_type, count(*)::int AS n,
             count(*) FILTER (WHERE batch_no IS NOT NULL)::int AS batched,
             min(created_at)::text AS first_seen, max(created_at)::text AS last_seen
      FROM scm.inventory_lots WHERE company_id = ${COMPANY_ID}
      GROUP BY source_doc_type ORDER BY n DESC`;
    for (const x of r) {
      out(`  lots from ${String(x.source_doc_type ?? "(null)").padEnd(8)} ${String(x.n).padStart(6)}  batched ${String(x.batched).padStart(6)}  ${x.first_seen?.slice(0, 10)} .. ${x.last_seen?.slice(0, 10)}`);
    }
  });

  // ── Reconstruction feasibility ──────────────────────────────────────────
  await section("8. TIER A candidates: provable PO line -> SO line via the delivered chain", async () => {
    // A PO line is Tier-A reconstructable when its goods physically shipped:
    // batch_no = this PO number was consumed by / moved out on a DO, that DO
    // line carries an so_item_id (or its header an so_doc_no), and the SKU
    // matches. Ambiguity is measured, not hidden: a PO line matching >1 distinct
    // SO is NOT provable and is counted separately.
    const rows = await pg`
      WITH ship AS (
        -- (po_number, do_id, product_code) buckets whose goods came from that PO
        SELECT l.batch_no AS po_number, cc.source_doc_id AS do_id, cc.product_code
        FROM scm.inventory_lot_consumptions cc
        JOIN scm.inventory_lots l ON l.id = cc.lot_id
        WHERE cc.company_id = ${COMPANY_ID} AND cc.source_doc_type = 'DO' AND l.batch_no IS NOT NULL
        UNION
        SELECT m.batch_no, m.source_doc_id, m.product_code
        FROM scm.inventory_movements m
        WHERE m.company_id = ${COMPANY_ID} AND m.source_doc_type = 'DO'
          AND m.movement_type = 'OUT' AND m.batch_no IS NOT NULL
      ),
      shipped_so AS (
        SELECT s.po_number, s.product_code,
               COALESCE(si.doc_no, d.so_doc_no) AS so_doc_no,
               di.so_item_id
        FROM ship s
        JOIN scm.delivery_orders d ON d.id = s.do_id AND d.company_id = ${COMPANY_ID}
                                  AND d.status::text <> 'CANCELLED'
        JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
                                        AND di.item_code = s.product_code
                                        AND di.company_id = ${COMPANY_ID}
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
      ),
      poline AS (
        SELECT i.id AS po_item_id, i.so_item_id, i.material_code, p.po_number
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE i.company_id = ${COMPANY_ID}
      )
      SELECT count(*)::int AS po_lines_with_ship_evidence,
             count(*) FILTER (WHERE so_n = 1)::int AS unambiguous,
             count(*) FILTER (WHERE so_n = 1 AND cur_link IS NULL)::int AS unambiguous_and_currently_null,
             count(*) FILTER (WHERE so_n = 1 AND cur_link IS NOT NULL)::int AS unambiguous_already_linked,
             count(*) FILTER (WHERE so_n > 1)::int AS ambiguous_multi_so
      FROM (
        SELECT pl.po_item_id, pl.so_item_id AS cur_link,
               count(DISTINCT ss.so_doc_no)::int AS so_n
        FROM poline pl
        JOIN shipped_so ss ON ss.po_number = pl.po_number AND ss.product_code = pl.material_code
        WHERE ss.so_doc_no IS NOT NULL
        GROUP BY pl.po_item_id, pl.so_item_id
      ) q`;
    const x = rows[0];
    out(`  PO lines with delivered-chain evidence:        ${x.po_lines_with_ship_evidence}`);
    out(`  ... resolving to EXACTLY ONE SO (provable):    ${x.unambiguous}`);
    out(`      of which so_item_id is currently NULL:     ${x.unambiguous_and_currently_null}   <- Tier A backfill size`);
    out(`      of which already linked:                   ${x.unambiguous_already_linked}`);
    out(`  ... resolving to >1 SO (NOT provable):         ${x.ambiguous_multi_so}`);
    const exact = await pg`
      WITH ship AS (
        SELECT l.batch_no AS po_number, cc.source_doc_id AS do_id, cc.product_code
        FROM scm.inventory_lot_consumptions cc
        JOIN scm.inventory_lots l ON l.id = cc.lot_id
        WHERE cc.company_id = ${COMPANY_ID} AND cc.source_doc_type = 'DO' AND l.batch_no IS NOT NULL
        UNION
        SELECT m.batch_no, m.source_doc_id, m.product_code FROM scm.inventory_movements m
        WHERE m.company_id = ${COMPANY_ID} AND m.source_doc_type='DO' AND m.movement_type='OUT' AND m.batch_no IS NOT NULL
      )
      SELECT count(DISTINCT di.so_item_id)::int AS resolvable_so_items
      FROM ship s
      JOIN scm.delivery_order_items di ON di.delivery_order_id = s.do_id AND di.item_code = s.product_code
      WHERE di.company_id = ${COMPANY_ID} AND di.so_item_id IS NOT NULL`;
    out(`  distinct SO lines reachable from a batched shipment: ${exact[0].resolvable_so_items}`);
  });

  await section('9. TIER B candidates: "From SOs:" note naming exactly one SO', async () => {
    const rows = await pg`
      SELECT p.po_number, p.notes
      FROM scm.purchase_orders p
      WHERE p.company_id = ${COMPANY_ID} AND p.notes ILIKE '%From SOs%'
      ORDER BY p.po_date LIMIT 40`;
    out(`  POs with the note (first ${rows.length} shown):`);
    for (const r of rows) {
      const m = /From SOs:\s*([^\n]*)/i.exec(r.notes ?? "");
      out(`    ${r.po_number}  ->  ${m ? m[1].trim().slice(0, 80) : "(unparseable)"}`);
    }
  });

  await section("10. TIER C (GUESS territory): SKU-unique PO<->SO pairing", async () => {
    // Purely informational: for PO lines with NO evidence at all, how often is
    // there exactly ONE company SO line with the same SKU whose delivery date is
    // after the PO date? This is a COINCIDENCE metric, not a fact - reported so
    // the size of the "we would be guessing" bucket is explicit.
    const r = await pg`
      WITH bare AS (
        SELECT i.id, i.material_code, p.po_date, p.po_number
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE i.company_id = ${COMPANY_ID} AND i.so_item_id IS NULL
          AND COALESCE(p.notes,'') NOT ILIKE '%From SOs%'
          AND NOT EXISTS (SELECT 1 FROM scm.inventory_lots l WHERE l.batch_no = p.po_number)
          AND NOT EXISTS (SELECT 1 FROM scm.inventory_movements m
                           WHERE m.batch_no = p.po_number AND m.source_doc_type='DO' AND m.movement_type='OUT')
      )
      SELECT count(*)::int AS bare_lines,
             count(*) FILTER (WHERE cand = 1)::int AS one_candidate,
             count(*) FILTER (WHERE cand > 1)::int AS many_candidates,
             count(*) FILTER (WHERE cand = 0)::int AS no_candidate
      FROM (
        SELECT b.id,
               (SELECT count(DISTINCT s.doc_no) FROM scm.mfg_sales_order_items s
                 WHERE s.company_id = ${COMPANY_ID} AND s.item_code = b.material_code
                   AND s.cancelled = false)::int AS cand
        FROM bare b
      ) q`;
    const x = r[0];
    out(`  PO lines with NO evidence of any kind: ${x.bare_lines}`);
    out(`    exactly one SO in the whole company sells that SKU: ${x.one_candidate}  (still a guess)`);
    out(`    many SOs sell that SKU: ${x.many_candidates}   no SO sells it at all: ${x.no_candidate}`);
  });

  // ── The specific documents the owner named ──────────────────────────────
  await section("11. The documents named in the report", async () => {
    const pos = await pg`
      SELECT p.po_number, p.po_date::text AS po_date, p.status,
             (SELECT count(*)::int FROM scm.purchase_order_items i WHERE i.purchase_order_id = p.id) AS lines,
             (SELECT count(*)::int FROM scm.purchase_order_items i WHERE i.purchase_order_id = p.id AND i.so_item_id IS NOT NULL) AS linked,
             COALESCE(p.notes,'') ILIKE '%From SOs%' AS has_note,
             (SELECT count(*)::int FROM scm.inventory_lots l WHERE l.batch_no = p.po_number) AS lots,
             (SELECT count(*)::int FROM scm.inventory_movements m WHERE m.batch_no = p.po_number) AS movs,
             (SELECT count(*)::int FROM scm.grns g WHERE g.purchase_order_id = p.id) AS grns
      FROM scm.purchase_orders p
      WHERE p.company_id = ${COMPANY_ID}
        AND p.po_number IN ('2990-PO-2606-001','2990-PO-2606-002')
      ORDER BY p.po_number`;
    for (const r of pos) {
      out(`  ${r.po_number} ${r.po_date} ${r.status}: lines=${r.lines} linked=${r.linked} note=${r.has_note} lots=${r.lots} movs=${r.movs} grns=${r.grns}`);
    }
    const grns = await pg`
      SELECT g.grn_number, g.received_at::text AS dt, g.status, g.purchase_order_id IS NULL AS orphan,
             p.po_number,
             (SELECT count(*)::int FROM scm.purchase_order_items i
               WHERE i.purchase_order_id = p.id AND i.so_item_id IS NOT NULL) AS po_linked_lines,
             (SELECT count(*)::int FROM scm.inventory_lots l WHERE l.batch_no = p.po_number) AS lots,
             (SELECT count(*)::int FROM scm.inventory_lot_consumptions cc
               JOIN scm.inventory_lots l2 ON l2.id = cc.lot_id
              WHERE l2.batch_no = p.po_number AND cc.source_doc_type='DO') AS do_consumptions
      FROM scm.grns g
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.company_id = ${COMPANY_ID}
        AND g.grn_number IN ('2990-GRN-2607-029','2990-GRN-2607-028','2990-GRN-2607-024','2990-GRN-2607-021')
      ORDER BY g.grn_number`;
    for (const r of grns) {
      out(`  ${r.grn_number} ${r.dt?.slice(0, 10)} ${r.status}: po=${r.po_number ?? "(none)"} po_linked_lines=${r.po_linked_lines ?? 0} lots=${r.lots ?? 0} do_consumptions=${r.do_consumptions ?? 0}`);
    }
  });

  // ── Q4: the SO-2607-028 sofa-set question ───────────────────────────────
  await section(`12. ${FOCUS_SO} - every line, warehouse, and delivered qty`, async () => {
    const hdr = await pg`
      SELECT doc_no, status, so_date::text AS so_date, customer_delivery_date::text AS cdd,
             amended_delivery_date::text AS add
      FROM scm.mfg_sales_orders WHERE company_id = ${COMPANY_ID} AND doc_no = ${FOCUS_SO}`;
    if (!hdr.length) { out(`  ${FOCUS_SO}: NOT FOUND for company ${COMPANY_ID}`); return; }
    out(`  header: status=${hdr[0].status} so_date=${hdr[0].so_date} cdd=${hdr[0].cdd} amended=${hdr[0].add}`);
    const lines = await pg`
      SELECT s.line_no, s.item_code, s.item_group, s.qty, s.cancelled,
             s.warehouse_id::text AS wh_id, w.code AS wh_code, w.is_active AS wh_active,
             s.line_delivery_date::text AS ldd,
             jsonb_array_length(COALESCE(s.variants->'cells','[]'::jsonb)) AS cells,
             (SELECT COALESCE(sum(di.qty),0) FROM scm.delivery_order_items di
               JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
              WHERE di.so_item_id = s.id AND d.status::text <> 'CANCELLED') AS delivered,
             (SELECT count(*)::int FROM scm.purchase_order_items i WHERE i.so_item_id = s.id) AS po_links
      FROM scm.mfg_sales_order_items s
      LEFT JOIN scm.warehouses w ON w.id = s.warehouse_id
      WHERE s.company_id = ${COMPANY_ID} AND s.doc_no = ${FOCUS_SO}
      ORDER BY s.line_no NULLS LAST, s.created_at`;
    out("  line# item_code                  group      qty cancelled wh          active cells delivered po_links");
    for (const l of lines) {
      out(`  ${String(l.line_no ?? "-").padStart(5)} ${String(l.item_code).padEnd(26)} ${String(l.item_group ?? "-").padEnd(10)} ${String(l.qty).padStart(3)} ${String(l.cancelled).padStart(9)} ${String(l.wh_code ?? (l.wh_id ? "UNKNOWN-ID" : "NULL")).padEnd(11)} ${String(l.wh_active ?? "-").padStart(6)} ${String(l.cells).padStart(5)} ${String(l.delivered).padStart(9)} ${String(l.po_links).padStart(8)}`);
    }
    const dos = await pg`
      SELECT d.do_number, d.status, d.do_date::text AS dt
      FROM scm.delivery_orders d
      WHERE d.company_id = ${COMPANY_ID} AND d.so_doc_no = ${FOCUS_SO} ORDER BY d.do_number`;
    out(`  DOs for this SO: ${dos.length ? dos.map((d) => `${d.do_number}=${d.status}`).join(", ") : "(none)"}`);
  });

  await section("13. Sofa SO warehouse fill rate (why a row shows no warehouse)", async () => {
    const r = await pg`
      SELECT count(*)::int AS sofa_lines,
             count(*) FILTER (WHERE s.warehouse_id IS NULL)::int AS no_wh,
             count(*) FILTER (WHERE s.warehouse_id IS NOT NULL AND w.id IS NULL)::int AS wh_missing_row,
             count(*) FILTER (WHERE w.id IS NOT NULL AND w.is_active = false)::int AS wh_inactive
      FROM scm.mfg_sales_order_items s
      LEFT JOIN scm.warehouses w ON w.id = s.warehouse_id
      WHERE s.company_id = ${COMPANY_ID} AND s.cancelled = false
        AND (s.item_group ILIKE '%SOFA%' OR EXISTS (
              SELECT 1 FROM scm.mfg_products p WHERE p.code = s.item_code AND p.category = 'SOFA'))`;
    const x = r[0];
    out(`  active sofa SO lines: ${x.sofa_lines}`);
    out(`    warehouse_id NULL:                 ${x.no_wh}   -> MRP renders "-" for the warehouse`);
    out(`    warehouse_id points at no row:     ${x.wh_missing_row}  -> also renders "-"`);
    out(`    warehouse row exists but INACTIVE: ${x.wh_inactive}  -> also renders "-" (MRP loads is_active=true only)`);
    const byso = await pg`
      SELECT count(*)::int AS sofa_sos,
             count(*) FILTER (WHERE wh_kinds > 1)::int AS split_across_wh,
             count(*) FILTER (WHERE null_wh > 0 AND null_wh < lines)::int AS partially_unmapped
      FROM (
        SELECT s.doc_no, count(*)::int AS lines,
               count(DISTINCT COALESCE(s.warehouse_id::text,'NULL'))::int AS wh_kinds,
               count(*) FILTER (WHERE s.warehouse_id IS NULL)::int AS null_wh
        FROM scm.mfg_sales_order_items s
        WHERE s.company_id = ${COMPANY_ID} AND s.cancelled = false
          AND (s.item_group ILIKE '%SOFA%' OR EXISTS (
                SELECT 1 FROM scm.mfg_products p WHERE p.code = s.item_code AND p.category='SOFA'))
        GROUP BY s.doc_no
      ) q`;
    out(`  sofa SOs: ${byso[0].sofa_sos}; whose modules SPLIT across >1 warehouse bucket: ${byso[0].split_across_wh} (each renders as TWO MRP rows)`);
    out(`    of those, partially unmapped (some lines NULL, some set): ${byso[0].partially_unmapped}`);
    const partial = await pg`
      SELECT count(*)::int AS n FROM (
        SELECT s.doc_no, count(*)::int AS lines,
               count(*) FILTER (WHERE COALESCE((
                 SELECT sum(di.qty) FROM scm.delivery_order_items di
                 JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                 WHERE di.so_item_id = s.id AND d.status::text <> 'CANCELLED'), 0) >= s.qty)::int AS done
        FROM scm.mfg_sales_order_items s
        WHERE s.company_id = ${COMPANY_ID} AND s.cancelled = false
          AND (s.item_group ILIKE '%SOFA%' OR EXISTS (
                SELECT 1 FROM scm.mfg_products p WHERE p.code = s.item_code AND p.category='SOFA'))
        GROUP BY s.doc_no
      ) q WHERE done > 0 AND done < lines`;
    out(`  sofa SOs PARTIALLY delivered (some modules shipped, some not): ${partial[0].n}`);
    out(`    -> MRP shows only the UNSHIPPED modules for these, so the set looks smaller than the SO`);
  });

  await section("14. Warehouse master (company scope + active flags)", async () => {
    const r = await pg`
      SELECT code, name, is_active, company_id FROM scm.warehouses
      WHERE company_id = ${COMPANY_ID} ORDER BY code`;
    for (const w of r) out(`  ${String(w.code).padEnd(12)} active=${w.is_active}  ${w.name}`);
  });

  // ── The hypothesis the note dump above raises ───────────────────────────
  await section("15. PREFIX MISMATCH: do the surviving references name the OLD doc numbers?", async () => {
    // The 2990 -> Houzs import renamed the DOCUMENTS (doc_no / po_number gained
    // a "2990-" prefix) but a reference stored as TEXT inside another column
    // (the "From SOs:" note, inventory batch_no) was not rewritten with them. If
    // so, the linkage is fully PRESENT and merely unresolvable by an equality
    // join - which is a very different finding from "the data is gone".
    const so = await pg`
      SELECT count(*)::int AS sos,
             count(*) FILTER (WHERE doc_no LIKE '2990-%')::int AS prefixed
      FROM scm.mfg_sales_orders WHERE company_id = ${COMPANY_ID}`;
    out(`  SO doc_no: ${so[0].sos} total, ${so[0].prefixed} carry the "2990-" prefix`);
    const po = await pg`
      SELECT count(*)::int AS pos,
             count(*) FILTER (WHERE po_number LIKE '2990-%')::int AS prefixed
      FROM scm.purchase_orders WHERE company_id = ${COMPANY_ID}`;
    out(`  PO po_number: ${po[0].pos} total, ${po[0].prefixed} carry the "2990-" prefix`);

    const tok = await pg`
      WITH tok AS (
        SELECT p.po_number, btrim(t) AS token
        FROM scm.purchase_orders p,
             LATERAL regexp_split_to_table(
               COALESCE((regexp_match(p.notes, 'From SOs?:[[:space:]]*([^\n\r]*)', 'i'))[1], ''), ',') AS t
        WHERE p.company_id = ${COMPANY_ID} AND p.notes ILIKE '%From SOs%'
      ), j AS (
        SELECT token,
               EXISTS (SELECT 1 FROM scm.mfg_sales_orders s
                        WHERE s.company_id = ${COMPANY_ID} AND s.doc_no = tok.token) AS asis,
               EXISTS (SELECT 1 FROM scm.mfg_sales_orders s
                        WHERE s.company_id = ${COMPANY_ID} AND s.doc_no = '2990-' || tok.token) AS prefixed
        FROM tok WHERE token <> ''
      )
      SELECT count(*)::int AS tokens,
             count(*) FILTER (WHERE asis)::int AS resolves_now,
             count(*) FILTER (WHERE NOT asis AND prefixed)::int AS resolves_with_prefix,
             count(*) FILTER (WHERE NOT asis AND NOT prefixed)::int AS unresolvable
      FROM j`;
    const t = tok[0];
    out(`  "From SOs:" tokens: ${t.tokens}`);
    out(`    resolve to a company SO AS-IS:            ${t.resolves_now}`);
    out(`    resolve ONLY after adding the "2990-" prefix: ${t.resolves_with_prefix}   <- silently invisible today`);
    out(`    resolve neither way (genuinely dangling):  ${t.unresolvable}`);

    const b = await pg`
      WITH b AS (
        SELECT DISTINCT batch_no FROM scm.inventory_lots
         WHERE company_id = ${COMPANY_ID} AND batch_no IS NOT NULL
        UNION
        SELECT DISTINCT batch_no FROM scm.inventory_movements
         WHERE company_id = ${COMPANY_ID} AND batch_no IS NOT NULL
      )
      SELECT count(*)::int AS batches,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.purchase_orders p
                       WHERE p.company_id = ${COMPANY_ID} AND p.po_number = b.batch_no))::int AS asis,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM scm.purchase_orders p
                       WHERE p.company_id = ${COMPANY_ID} AND p.po_number = b.batch_no)
                       AND EXISTS (SELECT 1 FROM scm.purchase_orders p2
                       WHERE p2.company_id = ${COMPANY_ID} AND p2.po_number = '2990-' || b.batch_no))::int AS prefixed,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM scm.purchase_orders p
                       WHERE p.company_id = ${COMPANY_ID} AND p.po_number IN (b.batch_no, '2990-' || b.batch_no)))::int AS unmatched
      FROM b`;
    const x = b[0];
    out(`  distinct batch_no values on lots+movements: ${x.batches}`);
    out(`    match a company po_number AS-IS:              ${x.asis}`);
    out(`    match ONLY after adding the "2990-" prefix:   ${x.prefixed}   <- silently invisible today`);
    out(`    match neither way (free-text / foreign batch):${x.unmatched}`);
    const samp = await pg`
      SELECT DISTINCT batch_no FROM scm.inventory_lots
       WHERE company_id = ${COMPANY_ID} AND batch_no IS NOT NULL
       ORDER BY batch_no LIMIT 15`;
    out(`  sample batch_no values: ${samp.map((r) => r.batch_no).join(", ")}`);
  });

  await section("16. so_revisions.snapshot->poLinks (the amendment-time SO->PO freeze)", async () => {
    const r = await pg`
      SELECT count(*)::int AS revisions,
             count(*) FILTER (WHERE snapshot->'poLinks' IS NOT NULL
                                AND snapshot->'poLinks' <> '{}'::jsonb)::int AS with_links
      FROM scm.so_revisions
      WHERE so_doc_no IN (SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = ${COMPANY_ID})`;
    out(`  so_revisions rows for this company: ${r[0].revisions}, carrying a non-empty poLinks: ${r[0].with_links}`);
  });

  await section("17. Sofa SO set sizes: how many modules, how many still open", async () => {
    // Directly answers "why does one SO show 1 variant when a sofa is sold as a
    // set": the MRP shows only lines with qty REMAINING, so a set whose other
    // modules already shipped (or were cancelled) legitimately renders smaller.
    const rows = await pg`
      SELECT s.doc_no,
             count(*)::int AS lines_all,
             count(*) FILTER (WHERE s.cancelled)::int AS cancelled,
             count(*) FILTER (WHERE NOT s.cancelled AND COALESCE((
               SELECT sum(di.qty) FROM scm.delivery_order_items di
               JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
               WHERE di.so_item_id = s.id AND d.status::text <> 'CANCELLED'), 0) >= s.qty)::int AS fully_delivered,
             count(DISTINCT COALESCE(s.warehouse_id::text, 'NULL'))::int AS wh_buckets,
             min(split_part(s.item_code, '-', 1)) AS model
      FROM scm.mfg_sales_order_items s
      WHERE s.company_id = ${COMPANY_ID} AND s.doc_no LIKE '%-SO-2607-%'
        AND (s.item_group ILIKE '%SOFA%' OR EXISTS (
              SELECT 1 FROM scm.mfg_products p WHERE p.code = s.item_code AND p.category = 'SOFA'))
      GROUP BY s.doc_no ORDER BY s.doc_no`;
    out("  SO                    model        lines cancelled delivered wh_buckets  open_modules");
    for (const r of rows) {
      const open = r.lines_all - r.cancelled - r.fully_delivered;
      out(`  ${String(r.doc_no).padEnd(21)} ${String(r.model).padEnd(12)} ${String(r.lines_all).padStart(5)} ${String(r.cancelled).padStart(9)} ${String(r.fully_delivered).padStart(9)} ${String(r.wh_buckets).padStart(10)} ${String(open).padStart(13)}`);
    }
  });

  out("");
  out("Census complete. Read-only: no rows were written.");
} catch (e) {
  console.error(`FATAL (database unreachable or fatally wrong): ${e.message}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}

function pct(n, d) {
  const nn = Number(n), dd = Number(d);
  if (!dd) return "n/a";
  return `${((nn / dd) * 100).toFixed(1)}%`;
}
