#!/usr/bin/env node
/* backfill-ac-sofa-line-keys — give a MIGRATED SOFA's sales-order compartments
 * the account book's own line key, and refuse every build the document cannot
 * force.
 *
 * WHAT A MISSING KEY COSTS, and it is two things, not one:
 *
 *   1. THE ORDER CANNOT BE EDITED. src/scm/lib/autocount-line-keys.ts:155 —
 *      every ERP row behind one AutoCount line must carry the SAME key, and
 *      composeEdit treats a build whose compartments disagree (or hold none) as
 *      having no line identity at all. So one keyless compartment does not cost
 *      that row: it costs the WHOLE document its identity, and staff are
 *      refused with "the ERP cannot tell which lines AutoCount already has".
 *      The owner is about to open sales-order editing.
 *   2. THE RECONCILE CANNOT ANSWER IT. A sofa is one book line and one ERP row
 *      per compartment, so the compartment axis is only answerable over the
 *      whole build, and only the line key can regroup it. On 2026-09-08 that
 *      made 90 of 547 sales-order sofa lines UNREAD — not agreeing, not
 *      differing: outside every number anyone had been shown.
 *
 * ── WHY THIS SCRIPT WAS REWRITTEN, AND WHAT IT STOPPED DOING ───────────────
 * Its own rule stamped ZERO rows in every run it ever had — dry run
 * `34163860885`, 2026-09-07: "sofa builds 88 in 88 document/model group(s);
 * rows to key 0; no mapping 0; no AutoCount line 50; count mismatch 38". Both
 * refusal reasons were defects of the rule, not of the data:
 *
 *   · "no AutoCount line" — it resolved a build to `<model>-1S` and looked that
 *     up in the mapping sheet, WITHOUT folding SOFA_MODEL_ALIAS. The floor
 *     writes one sofa under two numbers (5530/9028, 5536/9058, 5537/8030,
 *     5540/8030), so a `HOK-5530 SOFA` book line against our `9028-1A(LHF)`
 *     rows could never match. It also read `ac-outstanding-so.json.gz`, which
 *     is the OUTSTANDING cut — 2,789 documents against the book's own 13,378 —
 *     so a document whose sofa line had already been transferred carried no
 *     book line to match at all (the same blind spot docs/bugs/0694 records).
 *   · "count mismatch" — its build map was keyed by exactly the string it then
 *     grouped by, so a group ALWAYS held one build. A document holding two
 *     sofas of one model therefore read "1 build here, 2 AutoCount lines" and
 *     was refused by arithmetic rather than by ambiguity.
 *
 * It no longer carries a matching rule of its own. `lib/ac-forced-line-pairing.mjs`
 * is where "which book line is THIS row" lives — it folds our compartments into
 * builds, canonicalises both sides through `lib/keyless-multiset.mjs`'s
 * `comparisonKey` (alias and all; 5535 is its own model and is never folded),
 * and stamps ONLY where the document forces the answer. That module already
 * stamped the migrated goods receipts and delivery orders; this is the third
 * caller, not the third copy. Two tools answering one pairing question
 * differently, twenty minutes apart, is docs/bugs/0708.
 *
 * ── SCOPE: SALES ORDERS, AND ONLY THE SOFA BUILDS ON THEM ──────────────────
 * The whole document is PAIRED — it has to be, or a bucket's counts describe a
 * population the book does not hold — but only units the fold calls a SOFA are
 * stamped. Purchase orders are deliberately NOT touched: they are this lane's
 * CONTROL, and a tool that could move the control in the same dispatch is a
 * foot-gun. The non-sofa sales-order rows this run could have forced are
 * COUNTED and named below so the next lane inherits a number, not a guess.
 *
 * ── A LINE KEY IS AN IDENTITY, NOT A QUANTITY ──────────────────────────────
 * Stamping one must move no money, no quantity, no readiness and no stock. The
 * run PROVES that instead of asserting it: it takes a SHAPE — sums, per-status
 * counts, the migrated-document movement leak — before the write and re-takes
 * it afterwards ON A FRESH CONNECTION, and refuses to call the run clean if any
 * of it moved. A row count would agree with itself after a trigger rewrote
 * every value in the table; a sum would not.
 *
 * WHAT IT WILL NOT DO. Guess, and overwrite. A wrong DtlKey is strictly worse
 * than none: migration 0273 states that AcSyncService then APPENDS a line to
 * the live account book instead of editing the one that changed. NULL means
 * "create" and is refused loudly. A stored key that DISAGREES with the derived
 * one is REPORTED and left exactly where it is.
 *
 * PLAN by default. `MODE=apply` plus the CONFIRM phrase writes.
 *
 * RE-RUN: inert. Only rows with no `linked_ac_dtlkey` are stamped, the UPDATE
 * carries `AND linked_ac_dtlkey IS NULL` so losing a race is a no-op, and the
 * assignment is derived from a sorted plan, so a second run re-derives the same
 * keys and writes nothing.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { decodeSnapshot } from "./lib/ac-scope.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { foldErpUnits, planLineKeys } from "./lib/ac-forced-line-pairing.mjs";
import { erpReconcileTypes } from "./lib/ac-reconcile-erp-sql.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("need DATABASE_URL");
  process.exit(2);
}
/* PLAN unless somebody says otherwise. A bare run must never write. */
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
/* A phrase somebody has to TYPE. This writes line identity into the column the
   AutoCount write-back dereferences; `MODE=apply` alone is a keystroke. */
const CONFIRM_PHRASE = "STAMP SALES ORDER SOFA LINE KEYS";
if (APPLY && (process.env.CONFIRM ?? "").trim() !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
/* A cap, not a filter. The plan is printed in full; if it ever proposes more
   rows than this, something changed underneath and a human should look before
   a single row is written. */
const MAX_WRITES = Number(process.env.MAX_WRITES || 400);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

/* ── THE BOOK ──────────────────────────────────────────────────────────────
   The FULL cut, decoded by the module every other cutover script decodes it
   with. Not `ac-outstanding-so.json.gz`: that is the outstanding filter, and a
   sofa line already transferred is absent from it while its document is not. */
const snapPath = path.join(DATA, "ac-reconcile-truth.json.gz");
if (!fs.existsSync(snapPath)) {
  console.error(`REFUSED: ${snapPath} is missing. Export it from the book first.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const book = decodeSnapshot(snap);

/* The AutoCount -> ERP sheet, read ONCE and as RFC4180. `line.split(",")` cuts
   the rows whose ERP name carries an inch mark into fragments, and that alone
   invented 40 of 111 item-code "differences" (docs/bugs/0689). */
const MAPPING = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));

/** A book line in ERP terms. The code is translated through the sheet; where
 *  the sheet is silent the book's own code stands, which is what
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
   Sums and per-status counts, never row counts. */
async function shapeOf(sql) {
  const [li] = await sql`SELECT count(*)::int rows,
      COALESCE(sum(i.qty), 0)::text qty,
      COALESCE(sum(i.unit_price_sen), 0)::text unit_sen,
      COALESCE(sum(i.total_sen), 0)::text total_sen,
      COALESCE(sum(i.discount_sen), 0)::text discount_sen,
      count(*) FILTER (WHERE i.cancelled)::int cancelled
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO}`;
  const [hd] = await sql`SELECT count(*)::int rows,
      COALESCE(sum(subtotal_sen), 0)::text subtotal_sen,
      COALESCE(sum(local_total_sen), 0)::text local_total_sen
    FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;
  /* Readiness. A direct SQL write does NOT trigger an allocation recompute
     (docs/bugs/0675), which is exactly why these counts must be IDENTICAL
     either side of this run: a change would mean something other than a key
     moved. */
  const alloc = await sql`SELECT stock_status s, count(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} GROUP BY 1 ORDER BY 1`;
  const [mv] = await sql`SELECT count(*)::int rows, COALESCE(sum(qty), 0)::text units
    FROM scm.inventory_movements WHERE company_id = ${CO}`;
  /* The same JOIN check-stock-vs-autocount.mjs owns: a migrated document that
     posts stock double-counts against the seeded balance, and must be 0 on both
     sides of this run. */
  const [leak] = await sql`SELECT
      COUNT(*) FILTER (WHERE mv.source_doc_type::text = 'GRN')::int grn_rows,
      COUNT(*) FILTER (WHERE mv.source_doc_type::text = 'DO')::int  do_rows,
      COALESCE(SUM(ABS(mv.qty)),0)::int units
    FROM scm.inventory_movements mv
    LEFT JOIN scm.grns g            ON g.id = mv.source_doc_id AND mv.source_doc_type::text = 'GRN'
    LEFT JOIN scm.delivery_orders d ON d.id = mv.source_doc_id AND mv.source_doc_type::text = 'DO'
   WHERE mv.company_id = ${CO}
     AND (g.migrated_no_stock IS TRUE OR d.migrated_no_stock IS TRUE)`;
  return {
    so_items: li,
    sales_orders: hd,
    allocation: Object.fromEntries(alloc.map((r) => [r.s ?? "(null)", r.n])),
    inventory_movements: mv,
    migrated_movement_leak: leak,
  };
}

const printShape = (label, s) => {
  log(`${label}:`);
  plain(`      mfg_sales_order_items  rows ${s.so_items.rows}, qty ${s.so_items.qty}, unit_price_sen ${s.so_items.unit_sen}, total_sen ${s.so_items.total_sen}, discount_sen ${s.so_items.discount_sen}, cancelled ${s.so_items.cancelled}`);
  plain(`      mfg_sales_orders       rows ${s.sales_orders.rows}, subtotal_sen ${s.sales_orders.subtotal_sen}, local_total_sen ${s.sales_orders.local_total_sen}`);
  plain(`      SO line readiness      ${Object.entries(s.allocation).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  plain(`      inventory_movements    rows ${s.inventory_movements.rows}, units ${s.inventory_movements.units}`);
  plain(`      migrated-document movement LEAK (must be 0): ${s.migrated_movement_leak.grn_rows} GR rows, ${s.migrated_movement_leak.do_rows} DO rows, ${s.migrated_movement_leak.units} units`);
};

/** A stamp on a build the fold recognised as a sofa. `key` is what
 *  `comparisonKey` produced, so this is the fold's own word, not a re-test. */
const isSofaStamp = (s) => String(s.key || "").startsWith("SOFA ");

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company_id=${CO} book cut ${snap.exported_at}`);
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  const before = await shapeOf(sql);
  printShape("SHAPE BEFORE", before);

  /* The ERP side from the ONE module that defines it, so this writer stamps
     exactly the rows check-ac-erp-reconcile.mjs looks at — otherwise the payoff
     could not be measured, which is the point of the exercise. */
  const erpTypes = erpReconcileTypes({ sql, CO, PDATE: soProcessingDateFragment(sql) });
  const soRows = await erpTypes.find((c) => c.t === "SO").lines();

  const [all] = await sql`SELECT count(*)::int n,
      count(*) FILTER (WHERE i.linked_ac_dtlkey IS NOT NULL)::int keyed,
      count(*) FILTER (WHERE i.item_group ILIKE 'sofa')::int sofa,
      count(*) FILTER (WHERE i.item_group ILIKE 'sofa' AND i.linked_ac_dtlkey IS NULL)::int sofa_unkeyed
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO}`;
  log(
    `scm.mfg_sales_order_items: ${all.n} row(s) for company ${CO}, ${all.keyed} already carry an AutoCount line key; ` +
      `${all.sofa} are sofa rows and ${all.sofa_unkeyed} of those carry none; ` +
      `${soRows.length} sit on an order the book states a document number for`,
  );

  /* THE DOCUMENT that cannot be edited is the unit that matters for go-live, so
     it is counted before anything is planned: composeEdit refuses the WHOLE
     document when any one of a build's compartments is keyless. */
  const uneditableBefore = await sql`SELECT DISTINCT h.doc_no
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NULL`;
  log(`UNEDITABLE BEFORE: ${uneditableBefore.length} migrated sales order(s) hold at least one line with no AutoCount line key`);

  const erpByDoc = new Map();
  for (const r of soRows) {
    if (!erpByDoc.has(r.ac_no)) erpByDoc.set(r.ac_no, []);
    erpByDoc.get(r.ac_no).push({
      id: r.id,
      code: r.item_code,
      qty: r.qty,
      suffixed: Boolean(r.line_suffix),
      storedKey: r.ac_dtlkey,
      /* The build text the importer stored on the line. It is what tells two
         sofas of ONE model on one document apart, and the goods-receipt and
         delivery-order lanes pass none — see foldErpUnits. */
      desc2: r.description2,
    });
  }

  const { stamps, perDoc, totals } = planLineKeys({
    bookByDoc: bookByDoc(book.SO.lines, book.SO.desc2),
    erpByDoc,
  });

  const sofaStamps = stamps.filter(isSofaStamp);
  const otherStamps = stamps.filter((s) => !isSofaStamp(s));
  const sofaDocs = new Set(perDoc.filter((d) => d.stamped > 0).map((d) => d.docNo));
  log(
    `SO — ${totals.documents} sales order(s), ${totals.erpRows} line(s): ` +
      `${totals.stampedRows} row(s) the document FORCES (${totals.forcedUnique} the only candidate, ` +
      `${totals.forcedBuildText} matched one-to-one on the BUILD TEXT both sides state, ` +
      `${totals.forcedInterchangeable} where the book's own lines are identical and therefore interchangeable); ` +
      `${totals.alreadyKeyed} already keyed; ${totals.refusedRows} NOT forced; ` +
      `${totals.documentsNoBook} document(s) the book does not state; ` +
      `${totals.blankBookRows} book row(s) with no item code at all; ` +
      `${totals.disagreements} stored key(s) that DISAGREE with the derived one`,
  );
  log(
    `OF THOSE, THIS LANE WRITES ONLY THE SOFA BUILDS: ${sofaStamps.length} compartment row(s) on ` +
      `${new Set(sofaStamps.map((s) => s.dtlKey)).size} book line(s). ` +
      `${otherStamps.length} non-sofa sales-order row(s) are equally forced and are DEFERRED, not written — ` +
      "purchase orders are this lane's control and the plain lines are the next lane's number, measured not guessed.",
  );
  plain(`      documents with at least one forced row: ${sofaDocs.size}`);

  /* Every refusal, named. A bucket nobody can read is a bucket nobody
     re-checks — the failure the whole reconcile exists to prevent. */
  const refused = perDoc.filter((d) => d.refused > 0 && (d.reasons || []).length);
  if (refused.length) {
    log(`SO — the ${refused.length} document(s) that could NOT be forced, with the reason:`);
    for (const d of refused.slice(0, 80)) {
      plain(`      ${d.docNo}: ${d.refused} line(s) left unkeyed — ${d.reasons.join(" | ")}`);
    }
    if (refused.length > 80) plain(`      ... and ${refused.length - 80} more`);
  }
  for (const d of perDoc) {
    for (const a of d.audits ?? []) {
      plain(`      DISAGREEMENT ${d.docNo} row ${a.id}: stored ${a.stored}, this rule derives ${a.derived} — NOT overwritten`);
    }
  }

  if (sofaStamps.length > MAX_WRITES) {
    log(`REFUSED: the plan proposes ${sofaStamps.length} row(s), above the ${MAX_WRITES} cap. Read it, then raise MAX_WRITES deliberately.`);
    await sql.end();
    process.exit(2);
  }

  if (!APPLY) {
    log(
      `PLAN — ${sofaStamps.length} sofa compartment row(s) would be stamped. Read the refusals above, then re-run ` +
        `with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`,
    );
    await sql.end();
    return;
  }

  /* The write. `linked_ac_dtlkey IS NULL` in the predicate as well as in the
     plan: between the read and the write another lane may have stamped the same
     row, and losing that race must be a no-op, never an overwrite. */
  let written = 0;
  for (let i = 0; i < sofaStamps.length; i += 200) {
    const batch = sofaStamps.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of batch) {
        const r = await tx.unsafe(
          "UPDATE scm.mfg_sales_order_items SET linked_ac_dtlkey = $1 WHERE id = $2::uuid AND linked_ac_dtlkey IS NULL",
          [u.dtlKey, u.id],
        );
        written += r.count ?? 0;
      }
    });
    log(`  ..${Math.min(i + 200, sofaStamps.length)}/${sofaStamps.length}`);
  }
  log(`APPLIED: ${written} row(s) stamped of ${sofaStamps.length} planned`);
  await sql.end();

  /* ── THE PROOF, ON A FRESH CONNECTION ────────────────────────────────────
     A second connection, so nothing in this process's session state — a
     transaction snapshot, a `SET`, a cached plan — can make the after-shape
     agree with the before-shape for the wrong reason. */
  const verify = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const after = await shapeOf(verify);
  printShape("SHAPE AFTER (fresh connection)", after);

  /* THE SHAPE OF WHAT WAS WRITTEN, re-read, not counted. Every build we touched
     must now hold ONE key across ALL its rows and that key must be a positive
     integer — the exact condition composeEdit tests before it will address a
     line, so a row count here would prove nothing composeEdit cares about. */
  const touched = [...new Set(sofaStamps.map((s) => s.id))];
  const shapeRows = touched.length
    ? await verify`SELECT i.id::text AS id, h.doc_no,
          i.linked_ac_dtlkey::text AS key,
          (i.linked_ac_dtlkey IS NOT NULL) AS present,
          (pg_typeof(i.linked_ac_dtlkey)::text = 'bigint') AS is_bigint,
          i.item_code
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
        WHERE i.id::text = ANY(${touched})`
    : [];
  const wantById = new Map(sofaStamps.map((s) => [String(s.id), String(s.dtlKey)]));
  const wrongShape = shapeRows.filter(
    (r) => !r.present || !r.is_bigint || !/^\d+$/.test(String(r.key)) || wantById.get(r.id) !== String(r.key),
  );
  /* ── THE GUARANTEE composeEdit ACTUALLY READS ────────────────────────────
     Not "the row has a key" but "every compartment of THIS BUILD agrees on it"
     (src/scm/lib/autocount-line-keys.ts:155). So the verification has to know
     what a build IS, and `foldErpUnits` is the only thing that does — the same
     function the plan used, re-run over what the database now holds. Grouping
     by the MODEL instead answered a different question and refused apply run
     34210459226 after a correct write: since two sofas of one model on one
     document are two builds with two keys, 36 correct documents read as "not
     agreeing on one key". A verifier that cannot tell the intended outcome from
     the damage is not a verifier. */
  const touchedDocs = [...new Set(shapeRows.map((r) => r.doc_no))];
  const buildCheckRows = touchedDocs.length
    ? await verify`SELECT h.doc_no, i.id::text AS id, i.item_code, i.description2,
          i.line_suffix, i.qty::float8 AS qty, i.linked_ac_dtlkey::text AS key
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
        WHERE h.company_id = ${CO} AND h.doc_no = ANY(${touchedDocs}) AND i.item_group ILIKE 'sofa'`
    : [];
  const keyById = new Map(buildCheckRows.map((r) => [r.id, r.key ?? null]));
  const stampedIds = new Set(sofaStamps.map((s) => String(s.id)));
  const byDoc = new Map();
  for (const r of buildCheckRows) {
    if (!byDoc.has(r.doc_no)) byDoc.set(r.doc_no, []);
    byDoc.get(r.doc_no).push({
      id: r.id, code: r.item_code, qty: r.qty, suffixed: Boolean(r.line_suffix), desc2: r.description2,
    });
  }
  let buildGroups = 0;
  const splitBuilds = [];
  for (const [docNo, rows] of byDoc) {
    for (const u of foldErpUnits(rows)) {
      buildGroups++;
      /* null counts as a value: a build holding one key AND a keyless
         compartment is exactly the docs/bugs/0704 shape, and it must not read
         as "one key". A build that is keyless THROUGHOUT is a build this run
         could not force — reported by the refusal list, not damage. */
      const vals = new Set(u.ids.map((id) => keyById.get(id) ?? null));
      if (vals.size > 1) {
        splitBuilds.push({
          docNo, codes: u.codes.join("+"), rows: u.ids.length,
          keys: [...vals].map((v) => v ?? "(none)").join(", "),
          ours: u.ids.some((id) => stampedIds.has(id)),
        });
      }
    }
  }
  const brokenOurs = splitBuilds.filter((b) => b.ours);
  log(
    `VERIFIED ON A FRESH CONNECTION — ${shapeRows.length} of ${touched.length} stamped row(s) re-read; ` +
      `${wrongShape.length} WRONG SHAPE; ${buildGroups} sofa build(s) on the ${touchedDocs.length} document(s) ` +
      `touched, ${splitBuilds.length} of them NOT agreeing on one key, ${brokenOurs.length} of those stamped by THIS run`,
  );
  for (const b of splitBuilds.slice(0, 20)) {
    plain(
      `      ${b.ours ? "BROKEN BY THIS RUN" : "split, untouched by this run"} ${b.docNo} ${b.codes}: ` +
        `${b.rows} row(s) carrying ${b.keys}`,
    );
  }
  for (const r of wrongShape.slice(0, 20)) {
    plain(`      WRONG SHAPE ${r.doc_no} ${r.item_code}: key ${r.key ?? "(null)"} — wanted ${wantById.get(r.id)}`);
  }

  const uneditableAfter = await verify`SELECT DISTINCT h.doc_no
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NULL`;
  log(
    `UNEDITABLE AFTER: ${uneditableAfter.length} migrated sales order(s) still hold a line with no AutoCount line key ` +
      `(was ${uneditableBefore.length})`,
  );
  await verify.end();

  const drift = [];
  const cmp = (path_, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`${path_}: before ${JSON.stringify(a)} -> after ${JSON.stringify(b)}`);
  };
  for (const k of Object.keys(before)) cmp(k, before[k], after[k]);
  if (drift.length || wrongShape.length || brokenOurs.length) {
    log("REFUSED TO CALL THIS CLEAN:");
    for (const d of drift) plain(`      ${d}`);
    if (wrongShape.length) plain(`      ${wrongShape.length} stamped row(s) do not hold the key the plan derived`);
    if (brokenOurs.length) plain(`      ${brokenOurs.length} build(s) this run stamped no longer agree on one key`);
    process.exit(1);
  }
  log("PROVEN: money, quantities, readiness, stock and the migrated-document movement leak are IDENTICAL before and after. A line key is identity, not value.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
