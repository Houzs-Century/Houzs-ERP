#!/usr/bin/env node
/* repair-migrated-do-line-colour — put the fabric colour back on a MIGRATED
 * delivery-order line that lost it, by copying the SALES-ORDER line it delivers.
 *
 * ── WHAT IS WRONG, MEASURED ────────────────────────────────────────────────
 * The 2026-09-08 16:45 (+08) reconcile, run 34206269750, reports four delivery
 * lines on PROCEEDED orders where the account book states a fabric and the ERP
 * carries none. `ERP blank on a proceeded order` is the one column that table
 * calls WORK.
 *
 *   DO-004868 DtlKey 462399  VALKYRIE-(K)      book "NV-1WP"
 *   DO-011566 DtlKey 927185  BREEVA (W)-(SP)   book "taroni 1 cream"
 *   DO-011566 DtlKey 927187  FLAT-(Q)          book "taroni 1 cream x1"
 *   DO-011566 DtlKey 927189  FLAT-(Q)          book "taroni 10 sliver"
 *
 * Probe run 34210225334 read the ERP side: **the SALES ORDER behind every one
 * of them already carries exactly the colour the book states** — `NV-01`,
 * `TARONI-01`, `TARONI-01`, `TARONI-10`, each resolving to the same live
 * library row the book's own text resolves to. Only the delivery note is blank.
 * Both documents are `DELIVERED`, so nothing about what the customer received
 * is in question; the delivery paperwork simply does not repeat the fabric.
 *
 * ── THE RULE, AND WHY IT NEEDS NO PAIRING ──────────────────────────────────
 * `lib/migrated-do-writer.mjs` already states it: a migrated delivery line
 * takes `variants: t.variants ?? null` from the sales-order line it delivers.
 * This restores that rule where it left a line blank. It is a COPY of a value
 * this ERP already holds — 「migration copies, never computes」 — and the source
 * is the row the delivery line itself points at (`so_item_id`), so no line has
 * to be paired to a book line to decide it.
 *
 * That matters because two of the four sit on a bucket the line-key backfill
 * REFUSED (`lib/ac-forced-line-pairing.mjs`, run 34194376108): two `FLAT-(Q)`
 * rows at quantity 1 whose book lines differ only in Desc2. Which of our rows
 * is which is unknowable — and it does not need to be known, because each row
 * takes its colour from its OWN sales-order line.
 *
 * ── THE BOOK IS STILL THE AUTHORITY, AS A GUARD ────────────────────────────
 * 「一律跟账本」. Copying the sales order is only legitimate while the sales
 * order says what the book says, so a line is written ONLY when, for its whole
 * (document, item, quantity) bucket, the MULTISET of colours the book states
 * equals the MULTISET the bucket's sales-order lines carry — both resolved
 * through the ONE live fabric matcher, `active` included, because the library
 * renumbered itself on 2026-08-11 and a matcher without it answers the DEAD row
 * (that is how 166 sofa lines lost their colour). A bag is order-independent,
 * so this guard cannot be satisfied by an ordering and cannot be defeated by
 * one. A bucket whose two bags differ is REFUSED and printed by name.
 *
 * The book's own text is decoded by `decodeBook` with the WRITERS' decoders
 * passed in — never re-parsed here. A second copy of a Desc2 rule is this
 * repo's most expensive recurring bug.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * Overwrite. Only a line whose colour is BLANK is written; a line that holds a
 * colour, even a different one, is left alone and reported. Nothing else in
 * `variants` is touched: the sales-order line's colour key and value are merged
 * into the delivery line's existing object.
 *
 * It also does not enqueue anything to AutoCount — 「写回autocount的你不需要理
 * 了」, the owner, 2026-09-08. `scm.autocount_outbox` is counted in the shape
 * either side of the run precisely so that claim is measured and not asserted.
 *
 * MODE=plan by default; MODE=apply writes and needs the CONFIRM phrase.
 *
 * RE-RUN: inert. Only a line whose colour is still blank is written, and the
 * value written is what the sales-order line already holds, so a second run
 * finds nothing to do and prints zero candidates.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { decodeSnapshot } from "./lib/ac-scope.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { comparisonKey } from "./lib/keyless-multiset.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { decodeBook, pickAxis, AXES } from "./lib/variant-reconcile.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("need DATABASE_URL");
  process.exit(2);
}
/* PLAN BY DEFAULT. Any value that is not exactly "apply" plans. */
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
/* A phrase somebody has to TYPE. This writes what the factory and the customer
   read off a delivery note. */
const CONFIRM_PHRASE = "COPY DO COLOUR FROM SALES ORDER";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID ?? 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const COLOUR_KEYS = AXES.find((a) => a.key === "colour").erpKeys;

/* ── the book ─────────────────────────────────────────────────────────────── */
const snapPath = path.join(DATA, "ac-reconcile-truth.json.gz");
if (!fs.existsSync(snapPath)) {
  console.error(`REFUSED: ${snapPath} is missing. Export it from the book first.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const book = decodeSnapshot(snap);
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS ?? 2);
const AGE_DAYS = (Date.now() - Date.parse(snap.exported_at)) / 86_400_000;
if (!Number.isFinite(AGE_DAYS) || AGE_DAYS > MAX_AGE) {
  console.error(
    `REFUSED: the book snapshot is ${AGE_DAYS.toFixed(1)} days old (limit ${MAX_AGE}). ` +
      "Writing a colour from a stale book is how a corrected row gets un-corrected.",
  );
  process.exit(2);
}
const MAPPING = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));

/* ── THE SHAPE THAT MUST NOT MOVE ──────────────────────────────────────────
   Sums and per-status counts, not row counts: a row count agrees with itself
   after a trigger has rewritten every value in the table. A colour is a
   PROPERTY of a line — no money, no quantity, no stock, no queue. */
async function shapeOf(sql) {
  const [dl] = await sql`SELECT count(*)::int rows,
      COALESCE(sum(i.qty), 0)::text qty,
      COALESCE(sum(i.unit_price_sen), 0)::text unit_sen,
      COALESCE(sum(i.line_total_sen), 0)::text line_sen
    FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
    WHERE h.company_id = ${CO}`;
  const [dh] = await sql`SELECT count(*)::int rows, COALESCE(sum(local_total_sen), 0)::text total_sen,
      count(*) FILTER (WHERE migrated_no_stock)::int migrated,
      count(*) FILTER (WHERE status::text = 'CANCELLED')::int cancelled
    FROM scm.delivery_orders WHERE company_id = ${CO}`;
  const [mv] = await sql`SELECT count(*)::int rows, COALESCE(sum(qty), 0)::text units
    FROM scm.inventory_movements WHERE company_id = ${CO}`;
  /* The detector check-stock-vs-autocount.mjs owns, restated JOIN for JOIN: a
     migrated document that posts stock double-counts against the seeded
     balance, and must be 0 on both sides of this run. */
  const [leak] = await sql`SELECT
      COUNT(*) FILTER (WHERE mv.source_doc_type::text = 'DO')::int do_rows,
      COALESCE(SUM(ABS(mv.qty)),0)::int units
    FROM scm.inventory_movements mv
    JOIN scm.delivery_orders d ON d.id = mv.source_doc_id AND mv.source_doc_type::text = 'DO'
   WHERE mv.company_id = ${CO} AND d.migrated_no_stock IS TRUE`;
  /* 「写回autocount的你不需要理了」 — so the queue is MEASURED, not promised. */
  const [ob] = await sql`SELECT count(*)::int rows FROM scm.autocount_outbox`;
  /* A direct SQL write does not trigger an allocation recompute (docs/bugs/0675),
     which is exactly why these must be identical either side. */
  const alloc = await sql`SELECT stock_status s, count(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} GROUP BY 1 ORDER BY 1`;
  return {
    do_items: dl,
    delivery_orders: dh,
    inventory_movements: mv,
    migrated_movement_leak: leak,
    autocount_outbox: ob,
    allocation: Object.fromEntries(alloc.map((r) => [r.s ?? "(null)", r.n])),
  };
}

const printShape = (label, s) => {
  log(`${label}:`);
  plain(`      do_items            rows ${s.do_items.rows}, qty ${s.do_items.qty}, unit_price_sen ${s.do_items.unit_sen}, line_total_sen ${s.do_items.line_sen}`);
  plain(`      delivery_orders     rows ${s.delivery_orders.rows}, local_total_sen ${s.delivery_orders.total_sen}, migrated_no_stock ${s.delivery_orders.migrated}, cancelled ${s.delivery_orders.cancelled}`);
  plain(`      inventory_movements rows ${s.inventory_movements.rows}, units ${s.inventory_movements.units}`);
  plain(`      migrated-document movement LEAK (must be 0): ${s.migrated_movement_leak.do_rows} DO rows, ${s.migrated_movement_leak.units} units`);
  plain(`      autocount_outbox    rows ${s.autocount_outbox.rows}  (must not move: 写回autocount的你不需要理了)`);
  plain(`      SO line readiness   ${Object.entries(s.allocation).map(([k, v]) => `${k} ${v}`).join(", ")}`);
};

async function main() {
  log(`mode=${MODE} company_id=${CO} book cut ${snap.exported_at} (${AGE_DAYS.toFixed(2)} days old)`);
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  const before = await shapeOf(sql);
  printShape("SHAPE BEFORE", before);

  /* The live masters, read the way check-ac-erp-reconcile.mjs reads them so the
     repair and the check cannot disagree about what a colour IS. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label, active
    FROM scm.fabric_colours WHERE company_id = ${CO}`;
  if (fcRows.length < 50) {
    console.error(`REFUSED: only ${fcRows.length} fabric colours for company ${CO} — the matcher would answer null for everything.`);
    process.exit(2);
  }
  const { findColour } = buildFabricColourIndex(fcRows);
  const identity = (text) => {
    const h = text ? findColour(text) : null;
    return h ? `${h.fabric_id}|${h.colour_id}` : null;
  };
  const prodCodes = new Set(
    (await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`).map((p) =>
      String(p.code ?? "").trim().toUpperCase(),
    ),
  );
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const DEPS = {
    parseBedframe,
    parseSofa,
    isPendingColour,
    modelAlias: SOFA_MODEL_ALIAS,
    knownColour: (c) => (findColour(c) ? findColour(c).colour_id : null),
    reclOf: (m) => RECL.some((s) => prodCodes.has(`${m}${s}`.toUpperCase())),
  };
  log(`masters: ${fcRows.length} fabric colours, ${prodCodes.size} product codes`);

  /* WHEN each side was last written. Not every table here carries an
     `updated_at`, so the column is checked against information_schema before it
     is named in a SELECT: an absent column is the honest answer "this cut
     cannot say", never a killed statement. */
  const columnsOf = async (table) =>
    new Set((await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = ${table}`).map((r) => r.column_name));
  const doiCols = await columnsOf("delivery_order_items");
  const soiCols = await columnsOf("mfg_sales_order_items");
  const stamp = (cols, alias, col, out) => (cols.has(col) ? `${alias}.${col}::text AS ${out}` : `NULL AS ${out}`);

  /* Every migrated delivery line, with the sales-order line it delivers. */
  const rows = await sql.unsafe(
    `SELECT h.linked_ac_docno AS ac_no, h.do_number, h.status::text AS status,
      i.id::text AS id, COALESCE(i.line_no, 0) AS line_no, i.item_code, i.qty::float8 AS qty,
      i.line_suffix, i.item_group, i.variants, i.linked_ac_dtlkey::text AS dtlkey,
      ${stamp(doiCols, "i", "created_at", "do_created_at")},
      ${stamp(doiCols, "i", "updated_at", "do_updated_at")},
      s.id::text AS so_item_id, s.doc_no AS so_doc_no, s.variants AS so_variants,
      ${stamp(soiCols, "s", "updated_at", "so_updated_at")}
    FROM scm.delivery_order_items i
    JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
   WHERE h.company_id = $1 AND h.linked_ac_docno IS NOT NULL
     AND h.status::text <> 'CANCELLED'`,
    [CO],
  );
  log(`scm.delivery_order_items: ${rows.length} row(s) on ${new Set(rows.map((r) => r.ac_no)).size} migrated delivery order(s) for company ${CO}`);

  const bucketOf = (r) =>
    `${r.ac_no}|${comparisonKey({ code: r.item_code, side: "erp", suffixed: Boolean(r.line_suffix) }).key}|${Number(Number(r.qty ?? 0).toFixed(4))}`;
  const byBucket = new Map();
  for (const r of rows) {
    const b = bucketOf(r);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(r);
  }

  /* The book's colour for every line of every migrated delivery order, decoded
     by the writers' own decoders. */
  const bookBucket = new Map();
  for (const [docNo, ls] of book.DO.lines) {
    for (const l of ls) {
      const erpCode = MAPPING.get(normCode(l.itemKey))?.erp || l.itemKey;
      const { key } = comparisonKey({ code: erpCode, rawCode: l.itemKey, side: "book" });
      if (!key) continue;
      const b = `${docNo}|${key}|${Number(Number(l.qty ?? 0).toFixed(4))}`;
      if (!byBucket.has(b)) continue; // not a bucket the ERP holds; nothing to repair in it
      const group = String(byBucket.get(b)[0].item_group ?? "").toLowerCase();
      const text = book.DO.desc2.get(String(l.dtlKey)) ?? book.DO.desc2.get(l.dtlKey) ?? "";
      const decoded = decodeBook(DEPS, { desc2: text, itemGroup: group, itemCode: erpCode });
      if (!bookBucket.has(b)) bookBucket.set(b, []);
      bookBucket.get(b).push({ dtlKey: l.dtlKey, raw: decoded.colour, id: identity(decoded.colour) });
    }
  }

  const plan = [];
  const refusals = [];
  let blankLines = 0;

  for (const [b, ours] of byBucket) {
    const blanks = ours.filter((r) => !pickAxis(r.variants, COLOUR_KEYS));
    if (!blanks.length) continue;
    const bookLines = bookBucket.get(b) ?? [];
    /* Only a bucket where the BOOK states a colour is this script's business.
       A bucket the book says nothing about is BOOK-BLANK, and rule 2 says the
       ERP holding nothing there is CORRECT. */
    if (!bookLines.some((l) => l.raw)) continue;
    blankLines += blanks.length;

    const say = (reason) => refusals.push({ bucket: b, rows: blanks.length, reason });

    if (bookLines.length !== ours.length) {
      say(`the book states ${bookLines.length} line(s) of this item at this quantity and we hold ${ours.length} row(s)`);
      continue;
    }
    const missingSo = ours.filter((r) => !r.so_item_id);
    if (missingSo.length) {
      say(`${missingSo.length} of our ${ours.length} row(s) point at no sales-order line, so there is nothing to copy from`);
      continue;
    }
    const soIds = ours.map((r) => identity(pickAxis(r.so_variants, COLOUR_KEYS)));
    if (soIds.some((x) => !x)) {
      say("a sales-order line behind this bucket carries no colour the live fabric library resolves");
      continue;
    }
    const bookIds = bookLines.map((l) => l.id);
    if (bookIds.some((x) => !x)) {
      say(`the book's own colour text does not resolve in the live fabric library (${bookLines.map((l) => JSON.stringify(l.raw)).join(", ")})`);
      continue;
    }
    const bookBag = [...bookIds].sort();
    const soBag = [...soIds].sort();
    if (bookBag.join("|") !== soBag.join("|")) {
      say(`the book states {${bookBag.join(", ")}} and our sales-order lines carry {${soBag.join(", ")}} — copying the sales order would NOT be copying the book`);
      continue;
    }
    for (const r of blanks) {
      /* The KEY as well as the value comes from the sales-order line: what is
         written is character-for-character what the ERP already holds one
         document upstream. */
      const key = COLOUR_KEYS.find((k) => {
        const v = (r.so_variants || {})[k];
        return v != null && String(v).trim() !== "";
      });
      plan.push({
        id: r.id, ac: r.ac_no, doNumber: r.do_number, status: r.status, itemCode: r.item_code,
        dtlkey: r.dtlkey, soDocNo: r.so_doc_no, key, value: String(r.so_variants[key]).trim(),
        identity: identity(r.so_variants[key]), bookBag: bookBag.join(", "),
        /* WHEN each side was last written. The delivery line is a COPY of the
           sales-order line taken at migration time, so a sales-order line
           written AFTER the delivery row is the shape that explains a blank
           delivery line with a filled order behind it - printed rather than
           assumed, because that mechanism is otherwise a story. */
        doCreatedAt: r.do_created_at, doUpdatedAt: r.do_updated_at, soUpdatedAt: r.so_updated_at,
        variants: { ...(r.variants && typeof r.variants === "object" ? r.variants : {}), [key]: String(r.so_variants[key]).trim() },
      });
    }
  }

  log(
    `${blankLines} delivery line(s) carry NO colour while the book states one for their bucket: ` +
      `${plan.length} can be copied from their own sales-order line, ${blankLines - plan.length} REFUSED`,
  );
  for (const p of plan) {
    plain(
      `      ${p.ac} (ERP ${p.doNumber}, ${p.status}) ${p.itemCode} row ${p.id} DtlKey ${p.dtlkey ?? "NULL"}: ` +
        `variants.${p.key} <- ${JSON.stringify(p.value)} (${p.identity}) from ${p.soDocNo}; book bucket states {${p.bookBag}}` +
        `; DO row created ${p.doCreatedAt} updated ${p.doUpdatedAt}, SO line updated ${p.soUpdatedAt}`,
    );
  }
  for (const r of refusals) {
    plain(`      REFUSED ${r.bucket} — ${r.rows} blank row(s) left alone: ${r.reason}`);
  }

  if (!APPLY) {
    log(`PLAN ONLY — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  let written = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      /* The blank is in the PREDICATE as well as in the plan: between the read
         and the write another lane may have filled it, and losing that race
         must be a no-op rather than an overwrite. */
      const res = await tx`UPDATE scm.delivery_order_items
        SET variants = ${tx.json(p.variants)}
        WHERE id = ${p.id}::uuid
          AND COALESCE(NULLIF(TRIM(COALESCE(
                variants->>'fabricCode', variants->>'colorCode', variants->>'colourCode',
                variants->>'fabricColor', variants->>'colourId', '')), ''), '') = ''`;
      written += res.count ?? 0;
    }
  });
  log(`APPLIED: ${written} row(s) written of ${plan.length} planned`);
  await sql.end();

  /* ── THE PROOF, ON A FRESH CONNECTION ────────────────────────────────────
     A second connection, so nothing in this process's session state — a
     transaction snapshot, a SET, a cached plan — can make the after-shape agree
     with the before-shape for the wrong reason. */
  const verify = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const after = await shapeOf(verify);
  printShape("SHAPE AFTER (fresh connection)", after);
  /* And the one thing that MUST have changed, read back by value rather than by
     row count: every planned row now holds the colour that was planned for it. */
  const ids = plan.map((p) => p.id);
  const readBack = ids.length
    ? await verify`SELECT id::text AS id, variants FROM scm.delivery_order_items WHERE id = ANY(${ids}::uuid[])`
    : [];
  const byId = new Map(readBack.map((r) => [r.id, r]));
  const wrong = [];
  for (const p of plan) {
    const got = byId.get(p.id);
    const val = got ? pickAxis(got.variants, COLOUR_KEYS) : null;
    if (!got) wrong.push(`${p.id}: the row is gone`);
    else if (String(val).trim() !== p.value) wrong.push(`${p.id}: holds ${JSON.stringify(val)}, planned ${JSON.stringify(p.value)}`);
  }
  log(
    wrong.length
      ? `READ-BACK FAILED on ${wrong.length} of ${plan.length} row(s): ${wrong.join(" ; ")}`
      : `READ-BACK: all ${plan.length} row(s) hold the planned colour, read on a fresh connection.`,
  );
  await verify.end();

  const drift = [];
  const cmp = (path_, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`${path_}: before ${JSON.stringify(a)} -> after ${JSON.stringify(b)}`);
  };
  for (const k of Object.keys(before)) cmp(k, before[k], after[k]);
  if (drift.length || wrong.length) {
    log("REFUSED TO CALL THIS CLEAN:");
    for (const d of drift) plain(`      ${d}`);
    process.exit(1);
  }
  log(
    "PROVEN: money, quantities, readiness, stock, the migrated-document movement leak and the AutoCount outbox " +
      "are IDENTICAL before and after. A fabric colour is a property of a line, not a value in it.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
