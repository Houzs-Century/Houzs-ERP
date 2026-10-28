#!/usr/bin/env node
/* Retire the surplus MIGRATED delivery-order lines by setting qty to 0 and
   writing an audit note onto the line. The row STAYS.

   WHY THIS SHAPE AND NOT A DELETE, AND NOT A `cancelled` COLUMN.
   `create-migrated-documents.mjs` inserted some delivery lines twice - two
   mechanisms, both fixed in #1964 - so 8 migrated documents carry 18 surplus
   lines. Every surplus line is an EXACT duplicate of its twin on
   (so_item_id, item_code, qty), every one is `migrated_no_stock`, and there
   are ZERO inventory movements against any of them: no stock ever moved, so
   nothing about the ledger is wrong. What IS wrong is the order's arithmetic -
   `soDeliverableRemaining` sums non-cancelled DO lines by `so_item_id`, so a
   duplicate inflates "delivered" with no movement behind it.

   The owner's rule is that nothing is deleted, only cancelled, and
   `scm.delivery_order_items` has NO line-level cancel column. Adding one drags
   in the deferred line-retirement work on a third table
   (`docs/autocount-line-retirement-plan.md`), where a retained `cancelled` row
   is only correct once every reader excludes it. Option B in
   `docs/migrated-do-duplicate-lines.md` - the one the owner approved - keeps
   the row, sets its quantity to 0, and records what it was in the line's own
   description. Every "delivered" sum is SUM(qty), so a zero contributes
   nothing; no migration, no new column, no reader has to learn anything. When
   the retirement work lands the 18 rows are still there to be flipped.

   WHAT THIS REFUSES TO TOUCH.
     - any document that is NOT `migrated_no_stock`;
     - any document with ANY inventory movement against it, by any source type;
     - any group whose qty is already 0 (so a re-run is inert, and the zeroed
       rows can never re-group with each other and be zeroed again);
     - the FIRST row of every group, which is the real delivery line;
     - HC-DO-006224's genuine second unit. That document delivered a second
       ELEPAHNE-(SK) and AKEMI ARISTOI MATT (SK) two months after DO-005452
       against a 1-unit order. Keeping one row per group leaves that residue
       standing on purpose: it is a commercial question about a real shipment,
       for the owner, NOT an ERP defect. Do not "fix" it.

   THE MONEY DOES NOT MOVE. qty is the only quantitative column written; the
   per-line money columns and every header total are read before and after and
   asserted identical. A surplus line carrying money is reported and REFUSED,
   because zeroing its quantity while leaving its value would make the document
   inconsistent in a new way.

   DRY-RUN by default; APPLY=1 writes. One transaction. The verification read
   runs on a SECOND, FRESH connection - the connection that just wrote is the
   worst available witness (docs/jsonb-double-encoding-coe.md). */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const STAMP = process.env.NOTE_DATE || new Date().toISOString().slice(0, 10);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const err = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* The money columns a delivery line can carry. A surplus row is only safe to
   zero if all of them are absent or zero - otherwise the value stays behind a
   zero quantity and the document stops adding up. */
const MONEY = ["unit_price_sen", "discount_sen", "line_total_sen",
  "unit_cost_sen", "line_cost_sen", "line_margin_sen", "ship_cost_sen"];

const nz = (v) => v != null && Number(v) !== 0;

/* The note has to answer, years later and with no session to ask: what was
   this row, what was its number, which row carries the real delivery, who
   zeroed it and under what decision. */
const noteFor = (r) =>
  `[ZEROED ${STAMP}: duplicate migrated import line, original qty ${r.qty}. `
  + `The real delivery is row ${r.keep_id}. Written twice by `
  + `create-migrated-documents.mjs (writer fixed in PR #1964); this document is `
  + `migrated_no_stock with zero inventory movements, so no stock moved twice. `
  + `Row RETAINED, not deleted - owner decision Option B, `
  + `docs/migrated-do-duplicate-lines.md.]`;

async function groups(client) {
  /* qty <> 0 is load-bearing twice: it skips rows a previous run already
     zeroed, and it stops the zeroed rows of one group (5 of them on
     HC-DO-007525) from grouping with EACH OTHER at qty 0 on the next run. */
  return client`
    SELECT d.do_number, d.id::text AS do_id, d.so_doc_no, d.linked_ac_docno AS ac,
           UPPER(COALESCE(d.status::text,'')) AS status, d.migrated_no_stock AS mig,
           t.item_code, t.qty, t.so_item_id::text AS so_item_id, t.copies, t.ids,
           (SELECT COUNT(*)::int FROM scm.inventory_movements m
             WHERE m.source_doc_id = d.id) AS movements
      FROM scm.delivery_orders d
      JOIN (SELECT delivery_order_id, item_code, qty, so_item_id,
                   COUNT(*)::int AS copies,
                   ARRAY_AGG(id::text ORDER BY id) AS ids
              FROM scm.delivery_order_items
             WHERE qty <> 0
             GROUP BY delivery_order_id, item_code, qty, so_item_id
            HAVING COUNT(*) > 1) t ON t.delivery_order_id = d.id
     WHERE d.company_id = ${CO}
     ORDER BY d.do_number, t.item_code`;
}

// header money + line_count, the numbers that may not move
const headerTotals = (client, ids) => client`
  SELECT id::text AS id, do_number, line_count,
         local_total_sen, total_cost_sen, total_margin_sen,
         (SELECT COALESCE(SUM(qty),0)::numeric FROM scm.delivery_order_items i
           WHERE i.delivery_order_id = scm.delivery_orders.id) AS sum_qty,
         (SELECT COUNT(*)::int FROM scm.delivery_order_items i
           WHERE i.delivery_order_id = scm.delivery_orders.id) AS n_lines,
         (SELECT COALESCE(SUM(COALESCE(line_total_sen,0)),0)::numeric
            FROM scm.delivery_order_items i WHERE i.delivery_order_id = scm.delivery_orders.id) AS sum_line_total
    FROM scm.delivery_orders WHERE id = ANY(${ids}::uuid[]) ORDER BY do_number`;

// the arithmetic this whole exercise exists to correct
const overDelivered = (client, excl) => client`
  SELECT s.doc_no, s.item_code, s.id::text AS so_item_id, s.qty AS ordered,
         COALESCE(SUM(di.qty), 0)::numeric AS delivered
    FROM scm.mfg_sales_order_items s
    JOIN scm.delivery_order_items di ON di.so_item_id = s.id
    JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
    JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
   WHERE h.company_id = ${CO} AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     AND NOT (di.id::text = ANY(${excl}::text[]))
   GROUP BY s.doc_no, s.item_code, s.id, s.qty
  HAVING COALESCE(SUM(di.qty), 0) > s.qty
   ORDER BY s.doc_no, s.item_code`;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO} note_date=${STAMP}`);

  /* Prove what is attached to the table before writing to it. A BEFORE UPDATE
     trigger returning OLD, or one recomputing a total, would make every number
     below a fiction - and the catalogue is cheap to read. */
  const trg = await sql`
    SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'scm' AND c.relname = 'delivery_order_items' AND NOT t.tgisinternal`;
  log(`triggers on scm.delivery_order_items: ${trg.length || "none"}`);
  for (const t of trg) log(`   ${t.tgname}: ${t.def}`);

  const gs = await groups(sql);
  if (!gs.length) { log("no duplicate groups with a non-zero quantity. Nothing to do."); return; }

  const targets = [], refused = [];
  for (const g of gs) {
    const keep = g.ids[0], surplus = g.ids.slice(1);
    const why = !g.mig ? "document is NOT migrated_no_stock"
      : g.movements > 0 ? `document has ${g.movements} inventory movement(s)` : null;
    if (why) { refused.push({ g, why }); continue; }
    for (const id of surplus) targets.push({ ...g, id, keep_id: keep });
  }

  log("");
  log(`=== DUPLICATE GROUPS: ${gs.length} across ${new Set(gs.map((g) => g.do_number)).size} documents ===`);
  for (const g of gs) {
    log(`  ${g.do_number} (SO ${g.so_doc_no ?? "-"}, AC ${g.ac ?? "-"}, status=${g.status}, migrated=${g.mig}, movements=${g.movements})`);
    log(`     ${g.item_code} qty=${g.qty} so_item_id=${g.so_item_id ?? "NULL"} - ${g.copies} copies, ${g.copies - 1} SURPLUS`);
    log(`     keep ${g.ids[0]}   surplus ${g.ids.slice(1).join(", ")}`);
  }
  for (const r of refused) err(`REFUSED ${r.g.do_number} ${r.g.item_code}: ${r.why}`);

  /* EVERY PRIOR VALUE, IN FULL. Option B is reversible only if the row's whole
     state before the write is in the run log - "nothing is lost" in the
     owner's sense means the log is the backup, so print the entire row rather
     than the columns this script happens to care about. */
  const ids = targets.map((t) => t.id);
  log("");
  log(`=== PRIOR STATE OF EVERY SURPLUS ROW (${ids.length} rows, complete) ===`);
  const before = await sql`
    SELECT id::text AS id, to_jsonb(t) AS row FROM scm.delivery_order_items t
     WHERE id = ANY(${ids}::uuid[]) ORDER BY id`;
  const beforeById = new Map(before.map((b) => [b.id, b.row]));
  for (const t of targets) {
    log(`  ${t.do_number} ${t.item_code} surplus ${t.id} (twin ${t.keep_id})`);
    log(`     ${JSON.stringify(beforeById.get(t.id))}`);
  }
  if (before.length !== ids.length) { err(`expected ${ids.length} rows, read ${before.length}`); process.exit(1); }

  // a surplus line carrying money is refused, not zeroed
  const monied = before.filter((b) => MONEY.some((c) => nz(b.row[c])));
  log("");
  log(`surplus rows carrying a non-zero money column: ${monied.length}`);
  for (const m of monied) err(`REFUSED ${m.id}: ${MONEY.filter((c) => nz(m.row[c])).map((c) => `${c}=${m.row[c]}`).join(" ")}`);

  /* A surplus line with an invoice or a return hanging off it is NOT a spare
     copy - something downstream already counted it. remaining-to-invoice is
     delivered - invoiced - returned (do-line-remaining.ts), so zeroing such a
     row would drive that negative. Refuse it and say which document holds it. */
  const claimed = await sql`
    SELECT di.id::text AS id,
           (SELECT COUNT(*)::int FROM scm.sales_invoice_items si WHERE si.do_item_id = di.id) AS si,
           (SELECT COUNT(*)::int FROM scm.delivery_return_items dr WHERE dr.do_item_id = di.id) AS dr
      FROM scm.delivery_order_items di WHERE di.id = ANY(${ids}::uuid[])`;
  const claimedIds = new Set(claimed.filter((c) => c.si > 0 || c.dr > 0).map((c) => c.id));
  log(`surplus rows with an invoice or return line against them: ${claimedIds.size}`);
  for (const c of claimed) if (claimedIds.has(c.id)) err(`REFUSED ${c.id}: ${c.si} invoice line(s), ${c.dr} return line(s) point at it`);

  const write = targets.filter((t) => !monied.some((m) => m.id === t.id) && !claimedIds.has(t.id));

  const docIds = [...new Set(targets.map((t) => t.do_id))];
  const totalsBefore = await headerTotals(sql, docIds);
  log("");
  log("=== DOCUMENT TOTALS BEFORE ===");
  for (const h of totalsBefore) log(`  ${h.do_number} lines=${h.n_lines} line_count=${h.line_count} sum_qty=${h.sum_qty} local_total_sen=${h.local_total_sen} total_cost_sen=${h.total_cost_sen} total_margin_sen=${h.total_margin_sen} sum_line_total_sen=${h.sum_line_total}`);

  const overBefore = await overDelivered(sql, []);
  log("");
  log(`=== SALES-ORDER LINES READING AS OVER-DELIVERED, NOW: ${overBefore.length} ===`);
  for (const r of overBefore) log(`  ${r.doc_no} ${r.item_code}: ordered ${r.ordered}, delivered ${r.delivered}`);

  /* The projection, computed the same way the real query computes it, with the
     rows this run would zero excluded. This is what makes the apply
     predictable instead of hopeful - and it is where a residue shows up. */
  const overAfter = await overDelivered(sql, write.map((t) => t.id));
  const key = (r) => `${r.doc_no}|${r.item_code}`;
  const stillOver = new Set(overAfter.map(key));
  log("");
  log(`=== PROJECTED AFTER ZEROING ${write.length} ROWS: ${overAfter.length} over-delivered ===`);
  for (const r of overBefore) {
    const a = overAfter.find((x) => key(x) === key(r));
    log(`  ${r.doc_no} ${r.item_code}: ordered ${r.ordered}, delivered ${r.delivered} -> ${a ? `${a.delivered}  STILL OVER` : "CLEARS"}`);
  }
  for (const r of overAfter) if (!overBefore.some((x) => key(x) === key(r))) err(`NEW over-delivery introduced: ${r.doc_no} ${r.item_code}`);
  log(`  clears: ${overBefore.filter((r) => !stillOver.has(key(r))).length} of ${overBefore.length}`);

  /* A residue is only acceptable if it is a REAL second delivery. Name the
     documents still standing behind each one so the owner sees a shipment,
     not a number. */
  if (overAfter.length) {
    log("");
    log("  the delivery lines behind each residue (what the owner is looking at):");
    for (const r of overAfter) {
      const lines = await sql`
        SELECT d.do_number, d.do_date::text AS d, d.linked_ac_docno AS ac, di.qty, di.id::text AS id
          FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
         WHERE di.so_item_id = ${r.so_item_id}::uuid
           AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
         ORDER BY d.do_date, d.do_number`;
      log(`    ${r.doc_no} ${r.item_code} (ordered ${r.ordered}):`);
      for (const l of lines) {
        const z = write.some((t) => t.id === l.id);
        log(`       ${l.do_number} ${l.d} AC=${l.ac ?? "-"} qty=${l.qty}${z ? "  <- this run zeroes it" : ""}`);
      }
    }
  }

  if (!APPLY) {
    log("");
    log(`DRY-RUN: nothing written. ${write.length} rows would be zeroed. Re-run with APPLY=1.`);
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  const stamped = [];
  await sql.begin(async (tx) => {
    for (const t of write) {
      /* Compare-and-swap on the quantity that was READ. If anything moved the
         row between the read and the write, this matches nothing and the
         count below reports it - rather than zeroing a row whose meaning
         changed under us. */
      const back = await tx`
        UPDATE scm.delivery_order_items
           SET qty = 0,
               description = TRIM(BOTH ' ' FROM COALESCE(description, '') || ' ' || ${noteFor(t)})
         WHERE id = ${t.id}::uuid AND qty = ${t.qty}
        RETURNING id::text AS id, qty, description`;
      if (back.length !== 1) throw new Error(`row ${t.id} did not match qty=${t.qty} (matched ${back.length}) - aborting, nothing committed`);
      stamped.push(back[0]);
    }
  });
  log("");
  log(`APPLIED - ${stamped.length} rows came back from RETURNING (of ${write.length} intended).`);

  // ── VERIFY, ON A FRESH CONNECTION ────────────────────────────────────────
  /* A rowcount answers "did a row change", never "does the row now hold what
     I meant". Ask a different connection. */
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  try {
    const after = await v`
      SELECT id::text AS id, qty, description, to_jsonb(t) AS row
        FROM scm.delivery_order_items t WHERE id = ANY(${ids}::uuid[]) ORDER BY id`;
    log("");
    log(`=== INDEPENDENT READ-BACK (fresh connection): ${after.length} rows ===`);
    for (const a of after) {
      const wanted = write.some((t) => t.id === a.id);
      const b = beforeById.get(a.id);
      const ok = wanted
        ? Number(a.qty) === 0 && /\[ZEROED /.test(a.description || "")
        : String(a.qty) === String(b.qty) && a.description === b.description;
      if (!ok) { bad++; err(`row ${a.id} ${wanted ? "should be zeroed+noted" : "should be UNTOUCHED"} but reads qty=${a.qty} note=${/\[ZEROED /.test(a.description || "")}`); }
      log(`  ${a.id} ${wanted ? "zeroed" : "refused/untouched"} qty=${a.qty} description=${JSON.stringify(a.description)}`);
      // every other column must be untouched
      for (const c of Object.keys(b)) {
        if (c === "qty" || c === "description") continue;
        if (JSON.stringify(b[c]) !== JSON.stringify(a.row[c])) { bad++; err(`row ${a.id} column ${c} MOVED: ${JSON.stringify(b[c])} -> ${JSON.stringify(a.row[c])}`); }
      }
    }

    const totalsAfter = await headerTotals(v, docIds);
    log("");
    log("=== DOCUMENT TOTALS AFTER (must be identical except sum_qty) ===");
    for (const h of totalsAfter) {
      const b = totalsBefore.find((x) => x.id === h.id);
      log(`  ${h.do_number} lines=${h.n_lines} line_count=${h.line_count} sum_qty=${b.sum_qty} -> ${h.sum_qty} local_total_sen=${h.local_total_sen} total_cost_sen=${h.total_cost_sen} total_margin_sen=${h.total_margin_sen} sum_line_total_sen=${h.sum_line_total}`);
      for (const c of ["line_count", "local_total_sen", "total_cost_sen", "total_margin_sen", "n_lines", "sum_line_total"]) {
        if (String(b[c]) !== String(h[c])) { bad++; err(`${h.do_number} ${c} MOVED ${b[c]} -> ${h[c]}`); }
      }
    }

    const overNow = await overDelivered(v, []);
    log("");
    log(`=== OVER-DELIVERED, READ BACK: ${overNow.length} (was ${overBefore.length}, projected ${overAfter.length}) ===`);
    for (const r of overNow) log(`  ${r.doc_no} ${r.item_code}: ordered ${r.ordered}, delivered ${r.delivered}`);
    if (overNow.length !== overAfter.length) { bad++; err(`read-back ${overNow.length} over-delivered, projection said ${overAfter.length}`); }
  } finally { await v.end({ timeout: 5 }); }

  if (bad) { err(`${bad} verification failure(s)`); process.exit(1); }
  log("");
  log("VERIFIED on a fresh connection: quantities zeroed, notes present, every other column and every document total unchanged.");
}

main().then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
