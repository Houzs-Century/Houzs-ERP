#!/usr/bin/env node
/* backfill-ac-downstream-line-keys — give the MIGRATED goods receipts and
 * delivery orders the account book's own line key.
 *
 * THE OWNER, 2026-09-08: 「为什么会这样行号不一样呢？一定要一样的啊？」
 * They are not DIFFERENT. Migration 0280 added `linked_ac_dtlkey` to the four
 * downstream tables and its own header says "nothing backfills it: the keys are
 * stamped forward" — so every document the MIGRATION created kept NULL. This is
 * the backfill that header describes as absent, and it has been written into
 * three reports as a recommendation without ever being done.
 *
 * WHAT IT BUYS, both halves measured on the 2026-09-08 13:05 (+08) reconcile,
 * run 34189267879:
 *   · GR reported "item code: 2 (+34 where we hold no line key and both sides
 *     name the SAME goods)" and 44 documents it could not line-match at all.
 *     Every one of those is the checker GUESSING which of our rows answers
 *     which of the book's — the guess that produced five false alarms in two
 *     days, one of which (ten bedframe dedications) was genuinely wrong.
 *   · AcSyncService's /edit addresses a book row by `doc.EditDetail(dtlKey)`.
 *     With no key, editing a migrated goods receipt cannot name the line.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * Guess. The pairing rule lives in lib/ac-forced-line-pairing.mjs and stamps
 * only where the document FORCES the answer — read that module's header for the
 * three clauses and why each is safe. A wrong DtlKey makes AcSyncService append
 * a line to the LIVE account book instead of editing the one that changed
 * (migration 0273), so a refusal is the cheap outcome and a stamp is the
 * expensive one.
 *
 * ── A LINE KEY IS NOT MONEY, A QUANTITY OR A LINK ──────────────────────────
 * Stamping it must move no total, no quantity, no readiness and no stock. The
 * run PROVES that rather than asserting it: it takes a SHAPE — the sums,
 * the per-status counts, the migrated-document movement leak — before the
 * write, and re-takes it afterwards ON A FRESH CONNECTION, and prints both. A
 * count of updated rows would not have caught a trigger; a shape does.
 *
 * DRY-RUN by default; APPLY=1 writes. Read the per-document refusals in the
 * dry-run before applying: this writes LINE IDENTITY, and line identity is what
 * the edit path trusts.
 *
 * RE-RUN: inert. Only rows with no `linked_ac_dtlkey` are stamped, and a stored
 * key that DISAGREES with the derived one is REPORTED, never overwritten.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { buildScope, decodeSnapshot } from "./lib/ac-scope.mjs";
import { grPairGrain } from "./lib/ac-gr-pair-grain.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { planLineKeys } from "./lib/ac-forced-line-pairing.mjs";
import { erpReconcileTypes } from "./lib/ac-reconcile-erp-sql.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("need DATABASE_URL");
  process.exit(2);
}
const APPLY = process.env.APPLY === "1";
/* A phrase somebody has to TYPE. This writes line identity into a column the
   AutoCount write-back dereferences, and migration 0273 states what a wrong
   value there does: AcSyncService appends a line to the LIVE account book
   instead of editing the one that changed. APPLY=1 alone is a keystroke. */
const CONFIRM_PHRASE = "STAMP DOWNSTREAM LINE KEYS";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

/* ── THE BOOK ──────────────────────────────────────────────────────────────
   One snapshot, decoded by the module every other cutover script decodes it
   with. The goods-receipt half is restated at (receipt x purchase order) PAIR
   grain, because `scm.grns.purchase_order_id` is a SINGLE purchase order while
   an AutoCount receipt raises lines against several — lib/ac-gr-pair-grain.mjs
   carries the whole argument. The pair key it builds is character-for-character
   what check-ac-erp-reconcile.mjs's GR query selects as `ac_no`. */
const snapPath = path.join(DATA, "ac-reconcile-truth.json.gz");
if (!fs.existsSync(snapPath)) {
  console.error(`REFUSED: ${snapPath} is missing. Export it from the book first.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const book = decodeSnapshot(snap);
const SCOPE = buildScope(book);
const GR_PAIR = grPairGrain(book, SCOPE);

/* The AutoCount -> ERP sheet, read ONCE and correctly. `line.split(",")` cuts
   the three rows whose ERP name carries an inch mark (`DUNLOPILLO GENERASI 5""
   MATT (S)`) into fragments, and that invented 40 of the 111 item-code
   "differences" on the owner's table this morning (docs/bugs/0689). */
const MAPPING = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));

/** A book line in ERP terms. The code is translated through the sheet; where
 *  the sheet is silent the book's own code stands, which is exactly what
 *  lib/item-code-class.mjs compares against in that case. */
const toBookLine = (l, desc2) => ({
  dtlKey: l.dtlKey,
  rawCode: l.itemKey,
  code: MAPPING.get(normCode(l.itemKey))?.erp || l.itemKey,
  qty: l.qty,
  unitPriceSen: l.unitPriceSen,
  subTotalSen: l.subTotalSen,
  location: l.location,
  desc2: desc2.get(String(l.dtlKey)) ?? desc2.get(l.dtlKey) ?? null,
});

const bookByDoc = (linesMap, desc2) => {
  const m = new Map();
  for (const [docNo, ls] of linesMap) m.set(docNo, ls.map((l) => toBookLine(l, desc2)));
  return m;
};

/* ── THE SHAPE THAT MUST NOT MOVE ──────────────────────────────────────────
   Sums and per-status counts, not row counts. A row count agrees with itself
   after a trigger has rewritten every value in the table; a sum does not. */
async function shapeOf(sql) {
  const [gr] = await sql`SELECT count(*)::int rows,
      COALESCE(sum(i.qty_accepted), 0)::text qty,
      COALESCE(sum(i.unit_price_sen), 0)::text unit_sen,
      COALESCE(sum(i.qty_accepted * i.unit_price_sen), 0)::text ext_sen
    FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
    WHERE g.company_id = ${CO}`;
  const [gh] = await sql`SELECT count(*)::int rows, COALESCE(sum(total_sen), 0)::text total_sen,
      count(*) FILTER (WHERE status = 'CANCELLED')::int cancelled,
      count(*) FILTER (WHERE migrated_no_stock)::int migrated
    FROM scm.grns WHERE company_id = ${CO}`;
  const [dl] = await sql`SELECT count(*)::int rows,
      COALESCE(sum(i.qty), 0)::text qty,
      COALESCE(sum(i.unit_price_sen), 0)::text unit_sen
    FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
    WHERE h.company_id = ${CO}`;
  const [dh] = await sql`SELECT count(*)::int rows, COALESCE(sum(local_total_sen), 0)::text total_sen,
      count(*) FILTER (WHERE migrated_no_stock)::int migrated
    FROM scm.delivery_orders WHERE company_id = ${CO}`;
  /* The detector check-stock-vs-autocount.mjs owns (its lines 279-287),
     restated here JOIN for JOIN so the two ask the same question: a migrated
     document that posts stock double-counts against the seeded balance, and
     must be 0 on both sides of this run. */
  const [leak] = await sql`SELECT
      COUNT(*) FILTER (WHERE mv.source_doc_type::text = 'GRN')::int grn_rows,
      COUNT(*) FILTER (WHERE mv.source_doc_type::text = 'DO')::int  do_rows,
      COALESCE(SUM(ABS(mv.qty)),0)::int units
    FROM scm.inventory_movements mv
    LEFT JOIN scm.grns g            ON g.id = mv.source_doc_id AND mv.source_doc_type::text = 'GRN'
    LEFT JOIN scm.delivery_orders d ON d.id = mv.source_doc_id AND mv.source_doc_type::text = 'DO'
   WHERE mv.company_id = ${CO}
     AND (g.migrated_no_stock IS TRUE OR d.migrated_no_stock IS TRUE)`;
  const [mv] = await sql`SELECT count(*)::int rows, COALESCE(sum(qty), 0)::text units
    FROM scm.inventory_movements WHERE company_id = ${CO}`;
  /* Readiness. A direct SQL write does NOT trigger an allocation recompute
     (docs/bugs/0675) — which is exactly why these three numbers must be
     IDENTICAL either side of this run, and why a change in them would mean
     something other than this script moved. */
  const alloc = await sql`SELECT stock_status s, count(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} GROUP BY 1 ORDER BY 1`;
  return {
    grn_items: gr,
    grns: gh,
    do_items: dl,
    delivery_orders: dh,
    migrated_movement_leak: leak,
    inventory_movements: mv,
    allocation: Object.fromEntries(alloc.map((r) => [r.s ?? "(null)", r.n])),
  };
}

const printShape = (label, s) => {
  log(`${label}:`);
  plain(`      grn_items          rows ${s.grn_items.rows}, qty ${s.grn_items.qty}, unit_price_sen ${s.grn_items.unit_sen}, extended ${s.grn_items.ext_sen}`);
  plain(`      grns               rows ${s.grns.rows}, total_sen ${s.grns.total_sen}, cancelled ${s.grns.cancelled}, migrated_no_stock ${s.grns.migrated}`);
  plain(`      do_items           rows ${s.do_items.rows}, qty ${s.do_items.qty}, unit_price_sen ${s.do_items.unit_sen}`);
  plain(`      delivery_orders    rows ${s.delivery_orders.rows}, local_total_sen ${s.delivery_orders.total_sen}, migrated_no_stock ${s.delivery_orders.migrated}`);
  plain(`      inventory_movements rows ${s.inventory_movements.rows}, units ${s.inventory_movements.units}`);
  plain(`      migrated-document movement LEAK (must be 0): ${s.migrated_movement_leak.grn_rows} GR rows, ${s.migrated_movement_leak.do_rows} DO rows, ${s.migrated_movement_leak.units} units`);
  plain(`      SO line readiness  ${Object.entries(s.allocation).map(([k, v]) => `${k} ${v}`).join(", ")}`);
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company_id=${CO} book cut ${snap.exported_at}`);
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  const before = await shapeOf(sql);
  printShape("SHAPE BEFORE", before);

  /* ── THE ERP SIDE, FROM THE ONE MODULE THAT DEFINES IT ───────────────────
     `lib/ac-reconcile-erp-sql.mjs` is where "what the ERP holds for an AutoCount
     document" is stated — which table, which company filter, which rows count as
     cancelled, and (for a goods receipt) the `linked_ac_gr_docno|linked_ac_docno`
     PAIR grain that `scm.grns.purchase_order_id` being a single purchase order
     forces. Restating those SELECTs here would let this writer stamp rows the
     checker never looks at while leaving the ones it does — and the payoff
     could then not be measured, which is the whole point of the exercise. Same
     module, same rows, three callers now. */
  const erpTypes = erpReconcileTypes({ sql, CO, PDATE: soProcessingDateFragment(sql) });
  const linesOf = (t) => erpTypes.find((c) => c.t === t).lines();
  const grRows = await linesOf("GR");
  const doRows = await linesOf("DO");

  /* The DENOMINATORS, stated whole so no number below floats free. */
  const [grAll] = await sql`SELECT count(*)::int n,
      count(*) FILTER (WHERE i.linked_ac_dtlkey IS NOT NULL)::int keyed
    FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id WHERE g.company_id = ${CO}`;
  const [doAll] = await sql`SELECT count(*)::int n,
      count(*) FILTER (WHERE i.linked_ac_dtlkey IS NOT NULL)::int keyed
    FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
    WHERE h.company_id = ${CO}`;
  log(`scm.grn_items: ${grAll.n} rows for company ${CO}, ${grAll.keyed} already carry an AutoCount line key; ${grRows.length} sit on a receipt this run can address`);
  log(`scm.delivery_order_items: ${doAll.n} rows for company ${CO}, ${doAll.keyed} already carry one; ${doRows.length} sit on a delivery order this run can address`);

  const groupBy = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.ac_no)) m.set(r.ac_no, []);
      m.get(r.ac_no).push({
        id: r.id,
        code: r.item_code,
        qty: r.qty,
        suffixed: Boolean(r.line_suffix),
        storedKey: r.ac_dtlkey,
      });
    }
    return m;
  };

  const lanes = [
    {
      t: "GR",
      label: "goods receipt",
      table: "grn_items",
      bookByDoc: bookByDoc(GR_PAIR.view.lines, GR_PAIR.view.desc2),
      erpByDoc: groupBy(grRows),
    },
    {
      t: "DO",
      label: "delivery order",
      table: "delivery_order_items",
      bookByDoc: bookByDoc(book.DO.lines, book.DO.desc2),
      erpByDoc: groupBy(doRows),
    },
  ];

  const allStamps = [];
  for (const lane of lanes) {
    const { stamps, perDoc, totals } = planLineKeys({ bookByDoc: lane.bookByDoc, erpByDoc: lane.erpByDoc });
    log(
      `${lane.t} — ${totals.documents} ${lane.label} document(s), ${totals.erpRows} line(s): ` +
        `${totals.stampedRows} to stamp (${totals.forcedUnique} forced by being the only candidate, ` +
        `${totals.forcedInterchangeable} where the book's own lines are identical and therefore interchangeable); ` +
        `${totals.alreadyKeyed} already keyed; ${totals.refusedRows} NOT stamped; ` +
        `${totals.documentsFullyStamped} document(s) fully keyed; ` +
        `${totals.documentsNoBook} document(s) the book does not state; ` +
        `${totals.blankBookRows} book row(s) with no item code at all (AutoCount's own empty rows, not lines); ` +
        `${totals.disagreements} stored key(s) that DISAGREE with the derived one`,
    );

    /* Every refusal, named. A bucket nobody can read is a bucket nobody
       re-checks — the failure the whole reconcile exists to prevent. */
    const refused = perDoc.filter((d) => d.refused > 0);
    if (refused.length) {
      log(`${lane.t} — the ${refused.length} document(s) that could NOT be forced, with the reason:`);
      for (const d of refused.slice(0, 60)) {
        plain(`      ${d.docNo}: ${d.refused} line(s) left unkeyed — ${d.reasons.join(" | ")}`);
      }
      if (refused.length > 60) plain(`      ... and ${refused.length - 60} more`);
    }
    for (const d of perDoc) {
      for (const a of d.audits ?? []) {
        plain(`      DISAGREEMENT ${d.docNo} row ${a.id}: stored ${a.stored}, this rule derives ${a.derived} — NOT overwritten`);
      }
    }
    allStamps.push(...stamps.map((s) => ({ ...s, table: lane.table })));
  }

  if (!APPLY) {
    log(`DRY-RUN — ${allStamps.length} row(s) would be stamped. Read the refusals above, then re-run with APPLY=1 CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  /* The write. `linked_ac_dtlkey IS NULL` in the predicate as well as in the
     plan: between the read and the write another lane may have stamped the same
     row, and losing that race must be a no-op, never an overwrite. */
  let written = 0;
  for (let i = 0; i < allStamps.length; i += 200) {
    const batch = allStamps.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of batch) {
        const r = await tx.unsafe(
          `UPDATE scm.${u.table} SET linked_ac_dtlkey = $1 WHERE id = $2 AND linked_ac_dtlkey IS NULL`,
          [u.dtlKey, u.id],
        );
        written += r.count ?? 0;
      }
    });
    log(`  ..${Math.min(i + 200, allStamps.length)}/${allStamps.length}`);
  }
  log(`APPLIED: ${written} row(s) stamped of ${allStamps.length} planned`);
  await sql.end();

  /* ── THE PROOF, ON A FRESH CONNECTION ────────────────────────────────────
     A second connection, so nothing in this process's session state — a
     transaction snapshot, a `SET`, a cached plan — can make the after-shape
     agree with the before-shape for the wrong reason. */
  const verify = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const after = await shapeOf(verify);
  printShape("SHAPE AFTER (fresh connection)", after);
  const [keyed] = await verify`SELECT
      (SELECT count(*)::int FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
        WHERE g.company_id = ${CO} AND i.linked_ac_dtlkey IS NOT NULL) gr,
      (SELECT count(*)::int FROM scm.delivery_order_items i
        JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
        WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey IS NOT NULL) do_`;
  log(`AFTER: scm.grn_items carrying an AutoCount line key ${keyed.gr}/${grAll.n}; scm.delivery_order_items ${keyed.do_}/${doAll.n}`);
  await verify.end();

  const drift = [];
  const cmp = (path_, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`${path_}: before ${JSON.stringify(a)} -> after ${JSON.stringify(b)}`);
  };
  for (const k of Object.keys(before)) cmp(k, before[k], after[k]);
  if (drift.length) {
    log("REFUSED TO CALL THIS CLEAN — a line key moved something it must not:");
    for (const d of drift) plain(`      ${d}`);
    process.exit(1);
  }
  log("PROVEN: money, quantities, readiness, stock and the migrated-document movement leak are IDENTICAL before and after. A line key is identity, not value.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
