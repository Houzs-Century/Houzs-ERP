#!/usr/bin/env node
/* probe-do-colour-pairing — READ-ONLY.  Is the delivery-order colour swap REAL,
 * or is it the checker pairing two indistinguishable rows by position?
 *
 * ── THE QUESTION ───────────────────────────────────────────────────────────
 * The 2026-09-08 16:45 (+08) reconcile, run 34206269750, printed four fabric
 * colours on two delivery orders as an exact SWAP:
 *
 *   DO-011496 DtlKey 919934  book PC151-02  ERP PC151-03
 *   DO-011496 DtlKey 919942  book PC151-03  ERP PC151-02
 *   DO-010128 DtlKey 822696  book PC151-08  ERP PC151-06
 *   DO-010128 DtlKey 822698  book PC151-06  ERP PC151-08
 *
 * That is `docs/bugs/0689`, whose mechanism was recorded as UNKNOWN.  It is
 * ALSO the exact shape of this repo's most expensive recurring false alarm —
 * "two similar rows, no line key, paired by position, reported as transposed"
 * (docs/bugs/0672, 0688, 0695, 0696): five incidents, four of them phantoms.
 *
 * A checker that has to GUESS which of our rows answers which of the book's
 * cannot tell a real transposition from an arbitrary assignment.  So the first
 * question is not how to repair it.  It is whether there is anything to repair.
 *
 * ── WHAT DECIDES IT ────────────────────────────────────────────────────────
 * ONE fact per line: does the ERP row carry `linked_ac_dtlkey`?
 *
 *   carries one  the pairing is FORCED by the account book's own line number.
 *                A difference is then a real difference, and the customer is
 *                holding the wrong fabric.
 *   carries none the pairing was GUESSED — the checker falls back to
 *                (quantity, unit price) and then to document order, and on a
 *                migrated delivery order that carries no money at all, two
 *                lines of one product at one quantity are INDISTINGUISHABLE.
 *                The assignment is then arbitrary and a "swap" is what an
 *                arbitrary assignment of two values to two slots looks like
 *                half the time.
 *
 * And in the second case one further measurement settles what the document
 * actually says: the MULTISET.  If the bag of colours the book states for that
 * (item code, quantity) bucket equals the bag the ERP holds, then the delivery
 * order ships exactly the goods the book ordered, in exactly the right colours,
 * to one customer — and only the row LABELLING is unknowable.  A multiset needs
 * no pairing, so no ordering can fake it either way.
 *
 * ── WHY THIS IS NOT A GUESS ABOUT A GUESS ──────────────────────────────────
 * The key half is not inferred from the reconcile.  `backfill-ac-downstream-
 * line-keys.mjs` run 34194376108 (2026-09-08 14:22 +08, APPLY) printed its own
 * refusals, and these documents are in that list by name:
 *
 *   DO-011496: 2 line(s) left unkeyed — TRION (A) (HB STR)-(K): the book has 2
 *   lines of this item at this quantity and they are NOT identical (2 distinct
 *   price/location/Desc2 combinations), so which is which is unknowable
 *
 * `lib/ac-forced-line-pairing.mjs` refuses precisely when the two book lines
 * differ ONLY in Desc2 — and Desc2 is where the colour lives.  So the very fact
 * that makes the colours differ is the fact that made the key unstampable.
 * This probe confirms that refusal landed on production rather than trusting
 * the log, and reads the ERP side that no log states.
 *
 * ── ALSO ANSWERED, because it is the same axis and a different shape ────────
 * Four lines on PROCEEDED delivery orders where the book states a fabric and
 * the ERP holds nothing (DO-004868, DO-011566 x3).  Two of them sit in a bucket
 * whose pairing was ALSO refused — but both ERP rows are blank, so the verdict
 * is the same whichever way they pair, and the probe says so explicitly rather
 * than leaving the reader to notice.  The book's text is resolved through the
 * LIVE fabric library (`buildFabricColourIndex`, `active` included), because
 * the library renumbered itself on 2026-08-11 and a matcher without `active`
 * answers with the DEAD row — which is how 166 sofa lines lost their colour.
 *
 * ── FOR THE FLOOR ──────────────────────────────────────────────────────────
 * A delivery order is the paper the driver carries, so the probe prints, per
 * document, whether it has already gone out and what the sales order behind it
 * says — correcting a delivery note while its order still disagrees only moves
 * the mismatch.
 *
 * READ-ONLY BY CONSTRUCTION: every statement is a SELECT plus one
 * information_schema introspection.  There is no APPLY flag and no path through
 * this file that writes.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { decodeSnapshot } from "./lib/ac-scope.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { comparisonKey } from "./lib/keyless-multiset.mjs";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("need DATABASE_URL");
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID ?? 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

/* The documents the 16:45 reconcile named on the DO colour axis. Overridable
   with DOCS="DO-1,DO-2" so the next round needs no code change. DO-011518 is
   included deliberately: the ERP holds a colour the book never stated, which
   the owner's rule says an operator is allowed to fill in, and it is printed
   here so a reader can see it was looked at and left alone. */
const DEFAULT_DOCS = [
  "DO-011496", "DO-010128", // the "swap"
  "DO-004868", "DO-011566", // the book states a colour, the ERP holds none
  "DO-011518", // the ERP holds one the book never stated — NOT work
  "DO-011446", // the same shape on the gap / total-height axes, for the control
];
const DOCS = (process.env.DOCS ? process.env.DOCS.split(",") : DEFAULT_DOCS)
  .map((s) => s.trim())
  .filter(Boolean);

/* ── the book ─────────────────────────────────────────────────────────────── */
const snapPath = path.join(DATA, "ac-reconcile-truth.json.gz");
if (!fs.existsSync(snapPath)) {
  console.error(`REFUSED: ${snapPath} is missing. Export it from the book first.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const book = decodeSnapshot(snap);
const MAPPING = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));

const AGE_DAYS = (Date.now() - Date.parse(snap.exported_at)) / 86_400_000;
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS ?? 2);
if (!Number.isFinite(AGE_DAYS) || AGE_DAYS > MAX_AGE) {
  console.error(
    `REFUSED: the book snapshot is ${AGE_DAYS.toFixed(1)} days old (limit ${MAX_AGE}). ` +
      "Answering a colour question against a stale book is how a corrected row reads as a defect.",
  );
  process.exit(2);
}

/* The ERP keys a colour can be written under. Stated ONCE in
   lib/variant-reconcile.mjs's AXIS table; restated here would be a second
   statement of one rule, so it is imported in spirit and kept identical. */
const COLOUR_KEYS = ["fabricCode", "colorCode", "colourCode", "fabricColor", "colourId"];
const pickColour = (variants) => {
  if (!variants || typeof variants !== "object") return null;
  for (const k of COLOUR_KEYS) {
    const v = variants[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
};

async function columnsOf(sql, schema, table) {
  const rows = await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

async function main() {
  log(`READ-ONLY probe. company_id=${CO}; book cut ${snap.exported_at} (${AGE_DAYS.toFixed(2)} days old)`);
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

  /* The live fabric library, read with `active` so the matcher follows the
     2026-08-11 renumbering to the row that is alive today. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label, active
    FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const identity = (text) => {
    const h = text ? findColour(text) : null;
    return h ? `${h.fabric_id}|${h.colour_id}` : null;
  };
  if (fcRows.length < 50) {
    console.error(`REFUSED: only ${fcRows.length} fabric colours for company ${CO} — the matcher would answer null for everything.`);
    process.exit(2);
  }
  log(`fabric library: ${fcRows.length} rows for company ${CO}`);

  const doCols = await columnsOf(sql, "scm", "delivery_orders");
  const doiCols = await columnsOf(sql, "scm", "delivery_order_items");
  const has = (set, c) => set.has(c);
  const headPick = [
    "do_number", "linked_ac_docno", "id::text AS id",
    ...["do_date", "status", "delivery_state", "delivery_substatus", "shipout_date",
      "customer_delivered_date", "arrival_at", "migrated_no_stock", "on_hold",
      "debtor_code", "debtor_name", "local_total_sen"]
      .map((c) => (has(doCols, c) ? c : `NULL AS ${c}`)),
  ].join(", ");

  const heads = await sql.unsafe(
    `SELECT ${headPick} FROM scm.delivery_orders
      WHERE company_id = $1 AND linked_ac_docno = ANY($2)`,
    [CO, DOCS],
  );
  const headByAc = new Map(heads.map((h) => [h.linked_ac_docno, h]));

  const linePick = [
    "h.linked_ac_docno AS ac_no", "i.id::text AS id", "COALESCE(i.line_no, 0) AS line_no",
    "i.item_code", "i.qty::float8 AS qty", "i.created_at::text AS created_at",
    ...["unit_price_sen", "linked_ac_dtlkey", "line_suffix", "variants", "custom_specials",
      "description", "description2", "so_item_id", "item_group"]
      .map((c) => (has(doiCols, c) ? `i.${c}` : `NULL AS ${c}`)),
  ].join(", ");

  const lines = await sql.unsafe(
    `SELECT ${linePick} FROM scm.delivery_order_items i
       JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = $1 AND h.linked_ac_docno = ANY($2)
      ORDER BY h.linked_ac_docno, COALESCE(i.line_no, 0), i.created_at, i.id`,
    [CO, DOCS],
  );
  const linesByAc = new Map();
  for (const l of lines) {
    if (!linesByAc.has(l.ac_no)) linesByAc.set(l.ac_no, []);
    linesByAc.get(l.ac_no).push(l);
  }

  /* The SALES ORDER behind each delivery line. Correcting a delivery note while
     its order still says something else only moves the mismatch, so the order's
     own colour is read here rather than assumed to agree. */
  const soItemIds = lines.map((l) => l.so_item_id).filter(Boolean);
  const soRows = soItemIds.length
    ? await sql`SELECT i.id::text AS id, i.doc_no, COALESCE(i.line_no, 0) AS line_no,
          i.item_code, i.qty::float8 AS qty, i.variants, i.linked_ac_dtlkey,
          h.linked_ac_docno AS so_ac_no, h.processing_date
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
        WHERE h.company_id = ${CO} AND i.id = ANY(${soItemIds})`
    : [];
  const soById = new Map(soRows.map((r) => [r.id, r]));

  /* Does the ERP hold the sales order at all? A fully delivered order is
     CORRECTLY absent (the owner's DO rule), and "absent" and "disagrees" are
     very different answers to give the owner. */
  const bookSoNos = [
    ...new Set(
      DOCS.flatMap((d) => (book.DO.lines.get(d) || []).map((l) => l.fromDocNo)).filter(Boolean),
    ),
  ];
  const soHeads = bookSoNos.length
    ? await sql`SELECT doc_no, linked_ac_docno, processing_date
        FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND linked_ac_docno = ANY(${bookSoNos})`
    : [];
  const soHeadByAc = new Map(soHeads.map((r) => [r.linked_ac_docno, r]));

  let forced = 0;
  let guessed = 0;
  let bucketsEqual = 0;
  let bucketsDiffer = 0;

  for (const docNo of DOCS) {
    const head = headByAc.get(docNo);
    const bookLines = (book.DO.lines.get(docNo) || []).slice().sort((a, b) => a.seq - b.seq);
    const erpLines = linesByAc.get(docNo) || [];
    plain("");
    plain(`══════════ ${docNo} ══════════`);
    if (!head) {
      plain("  the ERP does not hold this delivery order at all.");
      continue;
    }
    plain(
      `  ERP ${head.do_number} — do_date ${head.do_date ?? "(none)"}, status ${head.status ?? "(none)"}, ` +
        `delivery_state ${head.delivery_state ?? "(none)"}${head.delivery_substatus ? `/${head.delivery_substatus}` : ""}, ` +
        `shipout ${head.shipout_date ?? "(none)"}, delivered_to_customer ${head.customer_delivered_date ?? "(none)"}, ` +
        `arrival_at ${head.arrival_at ?? "(none)"}, migrated_no_stock ${head.migrated_no_stock}, on_hold ${head.on_hold}`,
    );
    plain(`  customer ${head.debtor_code ?? "(none)"} ${head.debtor_name ?? ""}`);
    const soNos = [...new Set(bookLines.map((l) => l.fromDocNo).filter(Boolean))];
    for (const s of soNos) {
      const h = soHeadByAc.get(s);
      plain(
        `  book says its sales order is ${s} — the ERP ${h ? `holds it as ${h.doc_no} (processing_date ${h.processing_date ?? "(none)"})` : "does NOT hold it (correctly absent if every line is delivered — the owner's DO rule)"}`,
      );
    }
    plain(`  book lines ${bookLines.length}; ERP lines ${erpLines.length}`);

    /* Bucket both sides exactly the way lib/ac-forced-line-pairing.mjs does, so
       the reader sees the SAME buckets that decided whether a key was stamped.
       Sofa compartment rows fold to one unit there; none of these documents is
       a sofa, and a bucket whose two sides disagree in size is printed as such
       rather than silently folded. */
    const bookBucket = new Map();
    for (const l of bookLines) {
      const code = MAPPING.get(normCode(l.itemKey))?.erp || l.itemKey;
      const { key } = comparisonKey({ code, rawCode: l.itemKey, side: "book" });
      if (!key) continue;
      const b = JSON.stringify([key, Number(Number(l.qty ?? 0).toFixed(4))]);
      if (!bookBucket.has(b)) bookBucket.set(b, []);
      bookBucket.get(b).push(l);
    }
    const erpBucket = new Map();
    for (const l of erpLines) {
      const { key } = comparisonKey({ code: l.item_code, side: "erp", suffixed: Boolean(l.line_suffix) });
      if (!key) continue;
      const b = JSON.stringify([key, Number(Number(l.qty ?? 0).toFixed(4))]);
      if (!erpBucket.has(b)) erpBucket.set(b, []);
      erpBucket.get(b).push(l);
    }

    for (const [b, els] of erpBucket) {
      const bls = bookBucket.get(b) ?? [];
      const [keyName] = JSON.parse(b);
      const anyColour =
        bls.some((l) => book.DO.desc2.get(String(l.dtlKey))) || els.some((l) => pickColour(l.variants));
      if (!anyColour) continue; // no colour on either side: nothing this probe can say
      plain(`  ── bucket ${keyName} — book ${bls.length} line(s), ERP ${els.length} row(s)`);
      for (const l of bls) {
        const d2 = book.DO.desc2.get(String(l.dtlKey)) ?? book.DO.desc2.get(l.dtlKey) ?? null;
        plain(`       BOOK DtlKey ${l.dtlKey} (seq ${l.seq}) Desc2 ${JSON.stringify(d2)}`);
      }
      for (const l of els) {
        const c = pickColour(l.variants);
        const so = l.so_item_id ? soById.get(l.so_item_id) : null;
        const soC = so ? pickColour(so.variants) : null;
        plain(
          `       ERP  row ${l.id} line_no ${l.line_no} code ${JSON.stringify(l.item_code)} qty ${l.qty} ` +
            `linked_ac_dtlkey ${l.linked_ac_dtlkey ?? "NULL"} colour ${JSON.stringify(c)} -> ${identity(c) ?? "not in the library"}`,
        );
        plain(
          `             its sales-order line: ${so ? `${so.doc_no} line ${so.line_no} ${JSON.stringify(so.item_code)} colour ${JSON.stringify(soC)} -> ${identity(soC) ?? "not in the library"} (AC ${so.so_ac_no} DtlKey ${so.linked_ac_dtlkey ?? "NULL"})` : l.so_item_id ? `so_item_id ${l.so_item_id} — no such sales-order line for company ${CO}` : "no so_item_id: this delivery row is linked to no order line"}`,
        );
      }

      const keyedRows = els.filter((l) => l.linked_ac_dtlkey != null).length;
      forced += keyedRows;
      guessed += els.length - keyedRows;

      /* THE MULTISET. Resolved to library identities so a spelling cannot make
         two equal bags look different, and sorted so no ordering can make two
         different bags look equal. */
      const bookBag = bls
        .map((l) => book.DO.desc2.get(String(l.dtlKey)) ?? null)
        .map((t) => (t ? identity(colourTextOf(t)) ?? `unresolved:${colourTextOf(t)}` : "(blank)"))
        .sort();
      const erpBag = els
        .map((l) => pickColour(l.variants))
        .map((c) => (c ? identity(c) ?? `unresolved:${c}` : "(blank)"))
        .sort();
      const equal = JSON.stringify(bookBag) === JSON.stringify(erpBag);
      if (equal) bucketsEqual++;
      else bucketsDiffer++;
      plain(`       COLOUR MULTISET  book ${JSON.stringify(bookBag)}  vs  ERP ${JSON.stringify(erpBag)}  ->  ${equal ? "EQUAL" : "DIFFERENT"}`);
      if (keyedRows < els.length) {
        plain(
          `       ${els.length - keyedRows} of ${els.length} ERP row(s) in this bucket carry NO AutoCount line key, so which of our rows ` +
            `answers which of the book's is the checker's own GUESS${equal ? " — and the two bags are equal, so the goods and the colours are right whichever way they pair" : " — and the two bags DIFFER, so something is genuinely missing or wrong"}`,
        );
      }
    }
  }

  plain("");
  log(
    `TOTALS across the ${DOCS.length} document(s): ${forced} colour-bearing ERP row(s) whose pairing is FORCED by a line key, ` +
      `${guessed} whose pairing is GUESSED; ${bucketsEqual} bucket(s) whose colour multiset is EQUAL, ${bucketsDiffer} DIFFERENT.`,
  );
  await sql.end();
}

/* The colour phrase inside a Desc2. The decoders own the real rule; this probe
   only needs enough to hand the fabric matcher something to resolve, and it
   hands the WHOLE text when it cannot find a labelled clause — findColour is
   the thing that decides, not this. */
function colourTextOf(desc2) {
  const t = String(desc2 ?? "");
  const m = t.match(/(?:colou?r|clr)\s*[:：]?\s*([^/|,]+)/i);
  if (m) return m[1].trim();
  const first = t.split(/[/|]/)[0];
  return (first || t).trim();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
