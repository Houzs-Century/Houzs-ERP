#!/usr/bin/env node
/* THE OWNER'S RULING OF 2026-09-08, EXECUTED ON THE TWO SALES ORDERS IT NAMES.
 *
 * ── THE RULING, VERBATIM, AND WHAT HE WAS TOLD FIRST ───────────────────────
 *
 * He was shown the last three sales-order differences on the go-live reconcile
 * and told that two of them needed his decision BECAUSE this repo's standing
 * convention is NEVER DELETE, ONLY CANCEL. Knowing that, he answered:
 *
 *     「删掉啊 没写的也删掉
 *       简单来说都要跟Autocount一样啊 你不懂吗？」
 *
 *     "Delete it. The one that says nothing, delete that too.
 *      Put simply, everything has to be the same as AutoCount. Don't you
 *      understand?"
 *
 * That is an EXPLICIT, INFORMED override of the never-delete convention, for
 * these rows and the class they belong to. It is NOT a general licence: nothing
 * here may be widened into "deleting is fine now". The full record, including
 * where the class boundary is, is in docs/modules/sales-order.md ("The owner's
 * delete ruling") and docs/bugs/0712-the-owner-ruled-that-a-row-the-book-describes-nothing-in-is.md.
 *
 * ── WHAT IT WRITES — TWO LANES, BOTH PER-DOCUMENT, BOTH NAMED ──────────────
 *
 * There is no general rule here on purpose. Each target is a literal below and
 * every fact it rests on is ASSERTED against the committed book snapshot and
 * against the live ERP before anything is written; a target that fails one of
 * its assertions is REFUSED and named, never written on a guess.
 *
 * LANE `delete` — an ERP line the book does not have, removed.
 *   `HC-SO-013160` holds a 4th row, `STORAGE` RM 300.00, claiming AutoCount
 *   DtlKey 892917. That key is on NO document of ANY of the six types in the
 *   whole snapshot — searched, not assumed, and the search is one of the
 *   assertions below. The book's own three lines total RM 300.00 and ours total
 *   RM 600.00. The line was deleted in AutoCount after we imported it.
 *
 *   A DELETE CANNOT BE UNDONE BY REVERTING A COMMIT, so before the row is
 *   removed EVERY COLUMN OF IT is read with `SELECT *`, printed into the run log
 *   as JSON, and asserted non-empty. That printout is the recovery path.
 *
 *   It refuses unless ALL of these hold:
 *     * the book has no line anywhere carrying that DtlKey;
 *     * exactly ONE ERP row of that document carries it;
 *     * every OTHER ERP row of the document carries a DtlKey the book DOES
 *       have, so removing this one leaves the document equal to the book;
 *     * NO row in ANY table referencing `scm.mfg_sales_order_items` points at
 *       it. That sweep is taken from `pg_constraint` at run time, not from a
 *       list typed here, because the three FKs the module guide names
 *       (`purchase_order_items.so_item_id`, `delivery_order_items.so_item_id`,
 *       `sales_invoice_items.so_item_id`) are all ON DELETE SET NULL: a delete
 *       would SILENTLY unlink a real purchase order, delivery note or invoice
 *       and leave no trace. A composite FK is refused rather than guessed at.
 *
 * LANE `sofa-price` — a decomposed sofa priced above the book, brought to it.
 *   `HC-SO-012571`: the book states `DSL-8050 SOFA` RM 3,300.00 on ONE line and
 *   a `DISPOSE` line at RM 150.00, total RM 3,450.00. The ERP holds the sofa as
 *   one row per compartment and the money rides ONE of them at RM 3,388.00, so
 *   the document reads RM 3,538.00 — RM 88.00 over.
 *
 *   `repair-so-price-from-autocount.mjs` SKIPS every decomposed sofa by design,
 *   and THAT GUARD IS NOT LOOSENED: it is right for the general case, because
 *   which compartment carries the money is a decision. Here the decision is
 *   made, per document, and it is the SMALLEST one available — the money
 *   already rides exactly one compartment and it stays on that same one, at the
 *   book's number. Which compartment that is, is printed in the plan and in the
 *   verification. How a sofa's price is split across compartments is our
 *   internal representation; the book states one line and one number, and the
 *   only thing it states about this document is the total.
 *
 *   It refuses unless ALL of these hold: the book line exists, is a SOFA code,
 *   is MYR at rate 1, and its quantity matches the ERP row's; EXACTLY ONE ERP
 *   row of the compartment group carries money (if two did, which one to change
 *   would be a fresh decision); that row carries no line discount (a discount is
 *   `repair-so-line-discount.mjs`'s subject, not this one); and the group's
 *   total after the write equals the book's line to the sen.
 *
 * ── WHAT IT NEVER TOUCHES ──────────────────────────────────────────────────
 *   `paid_sen` and the header `balance_sen`. `HC-SO-012571`'s total FALLS by
 *     RM 88.00 and `HC-SO-013160`'s by RM 300.00; where that leaves a document
 *     whose total no longer equals paid + balance, the document is NAMED and the
 *     owner rules on it. What a customer paid is a fact about the business, not
 *     an arithmetic consequence of a corrected total.
 *   The AutoCount write-back. Owner, 2026-09-08: 「写回autocount的你不需要理了」.
 *     Nothing here enqueues an outbox row and nothing can: `scm.autocount_outbox`
 *     is written by application code only, there is no trigger on
 *     `scm.mfg_sales_order_items`, and the run PROVES it by counting that
 *     table's rows for both documents before and after rather than asserting it.
 *   Stock. No inventory movement is written and none is implied: the deleted row
 *     is a SERVICE line on migrated paperwork that moved no stock, and the sofa
 *     change is money only — no quantity, no item code, no status.
 *   Any document not named in the two target lists.
 *
 * MODE=plan (the default) writes nothing and IS the census.
 * MODE=apply needs CONFIRM="I HAVE REVIEWED THE OWNER DELETE RULING PLAN".
 * ONLY_DOCS="SO-013160" narrows the APPLY to the documents you read in the plan.
 * LANES="delete,sofa-price" selects lanes; both by default.
 * MAX_WRITES (default 2) refuses an apply wider than the plan you read.
 *
 * RE-RUN: idempotent and self-limiting in both directions. The delete lane
 * plans nothing once no ERP row of the document claims DtlKey 892917, so a
 * second run reports the document already agrees with the book and writes
 * nothing; it can never delete a second row, because the row it deletes is
 * identified by that key and by the assertion that the book has no such line.
 * The sofa lane plans nothing once the compartment already carries the book's
 * unit price. Both re-read inside the transaction before writing, so two runs
 * racing cannot double anything.
 *
 * RECOVERY IF THE RULING IS EVER REVERSED. The deleted row is printed in full
 * as JSON by the plan AND by the apply, and it is copied into
 * docs/bugs/0712-the-owner-ruled-that-a-row-the-book-describes-nothing-in-is.md. To put it back: INSERT one row into
 * `scm.mfg_sales_order_items` with exactly those column values (a fresh `id` is
 * fine — nothing referenced the old one, which is one of the preconditions of
 * the delete), then re-sum the header the way `applyHeader` below does. Nothing
 * else in the database has to change.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { currencyVerdict, decodeSnapshot } from "./lib/ac-scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUTH = path.join(HERE, "data", "ac-reconcile-truth.json.gz");

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const LANES = new Set(String(process.env.LANES || "delete,sofa-price").toLowerCase().split(/[,\s]+/).filter(Boolean));
const ONLY_DOCS = new Set(String(process.env.ONLY_DOCS || "").toUpperCase().split(/[,\s]+/).filter(Boolean));
const MAX_WRITES = Number(process.env.MAX_WRITES || 2);
const CONFIRM_PHRASE = "I HAVE REVIEWED THE OWNER DELETE RULING PLAN";

const note = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m = "") => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (s) => `RM ${(Number(s) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}

/* Byte-identical to repair-so-line-discount.mjs:76,
   repair-so-price-from-autocount.mjs:58 and topup-ac-lines-from-truth.mjs:145 —
   the header's five category buckets are DEFINED as the sum of their lines'
   `total_sen`, and there is one statement of which group falls in which. */
const BUCKET = {
  mattress: "mattress_sofa_sen", sofa: "mattress_sofa_sen", bedframe: "bedframe_sen",
  accessory: "accessories_sen", service: "service_sen", others: "others_sen",
};

/* AutoCount hands DtlKey back through sqlcmd, a JSON dump and a gzip; the ERP
   column is a bigint the pg driver may return as a string. Compare them as
   canonical decimal strings. (topup-ac-lines-from-truth.mjs:172, same reason.) */
const keyOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(/\.0+$/, "");
  return /^-?\d+$/.test(s) ? s : null;
};
const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));
const ON_DELETE = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

/* ── THE TARGETS ───────────────────────────────────────────────────────────
 * One entry per document the owner ruled on. Everything in them is CHECKED
 * below against the book and the ERP; nothing here is trusted because it is
 * typed here. */
const DELETE_TARGETS = [
  {
    acNo: "SO-013160",
    dtlKey: "892917",
    why: "the book has three lines totalling RM 300.00 and no line anywhere carries this key; ours has four " +
      "totalling RM 600.00. The line was deleted in AutoCount after we imported it.",
  },
];
const SOFA_PRICE_TARGETS = [
  {
    acNo: "SO-012571",
    dtlKey: "876762",
    why: "the book states DSL-8050 SOFA at RM 3,300.00 on one line; our compartment group carries RM 3,388.00, " +
      "so the document reads RM 88.00 over the book.",
  },
];

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

async function main() {
  if (!fs.existsSync(TRUTH)) {
    bad(`REFUSED: ${TRUTH} is missing. Re-cut it with export-ac-reconcile-truth.mjs.`);
    process.exit(2);
  }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(TRUTH)).toString("utf8"));
  const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
  note(`mode=${APPLY ? "APPLY" : "PLAN"}; AutoCount snapshot ${snap.exported_at} (${ageDays.toFixed(2)} days old); company ${CO}; lanes ${[...LANES].join(",")}`);
  if (!(ageDays <= MAX_AGE)) {
    bad(`REFUSED: the snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE}). Writing against a stale book is how a repair invents a difference.`);
    process.exit(2);
  }
  const book = decodeSnapshot(snap);

  /* EVERY DtlKey the book holds, across ALL SIX TYPES. The delete lane's central
     claim is "this key is on no document of any type", and it is proved here
     rather than quoted from a doc. */
  const everyBookKey = new Set();
  for (const payload of Object.values(book)) for (const k of payload.byDtlKey.keys()) everyBookKey.add(String(k));
  note(`book: ${everyBookKey.size} distinct DtlKeys across all six document types`);

  const refusals = [];
  const del = LANES.has("delete") ? await planDelete({ book, everyBookKey, refusals }) : [];
  const sofa = LANES.has("sofa-price") ? await planSofa({ book, refusals }) : [];

  plain("");
  note(`PLAN — ${del.length} line(s) to DELETE, ${sofa.length} sofa compartment(s) to RE-PRICE, ${refusals.length} target(s) REFUSED.`);
  for (const r of refusals) bad(`   REFUSED ${r}`);

  const armedDocs = [...del, ...sofa].map((w) => w.docNo);
  const outboxBefore = await outboxCount(armedDocs);
  note(`AutoCount outbox rows naming these documents, BEFORE: ${outboxBefore} (nothing here writes one; there is no trigger that could)`);

  if (!APPLY) {
    plain("");
    note("PLAN ONLY — nothing was written. Re-dispatch with apply=yes and the confirm phrase to write.");
    await sql.end({ timeout: 5 });
    if (refusals.length) process.exitCode = 1;
    return;
  }
  if (refusals.length) {
    bad("REFUSING TO WRITE: at least one target failed its own assertions. Fix the finding, do not narrow the lane.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const armed = [...del, ...sofa].filter((w) => !ONLY_DOCS.size || ONLY_DOCS.has(w.acNo.toUpperCase()));
  if (armed.length > MAX_WRITES) {
    bad(`REFUSED: ${armed.length} line write(s) is wider than MAX_WRITES=${MAX_WRITES}. Read the plan again before raising it.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  if (armed.length === 0) {
    note("Nothing to write — every target already agrees with the book.");
    await sql.end({ timeout: 5 });
    return;
  }

  const done = { deleted: 0, repriced: 0, headers: 0 };
  for (const w of armed) {
    await sql.begin(async (tx) => {
      if (w.lane === "delete") {
        /* Re-read INSIDE the transaction: the row this run planned against may
           have been removed by a concurrent run, and deleting "the fourth row"
           by anything other than its own key is how a repair takes the wrong
           one. */
        const live = await tx`SELECT id FROM scm.mfg_sales_order_items
                               WHERE doc_no = ${w.docNo} AND linked_ac_dtlkey::text = ${w.dtlKey}`;
        if (live.length !== 1) {
          note(`   ${w.docNo}: ${live.length} row(s) now carry DtlKey ${w.dtlKey} — expected exactly 1. Nothing deleted.`);
          return;
        }
        const gone = await tx`DELETE FROM scm.mfg_sales_order_items WHERE id = ${live[0].id} RETURNING id`;
        done.deleted += gone.length;
      } else {
        const live = await tx`SELECT id FROM scm.mfg_sales_order_items WHERE id = ${w.lineId}`;
        if (live.length !== 1) { note(`   ${w.docNo}: line ${w.lineId} is gone. Nothing repriced.`); return; }
        const u = await tx`UPDATE scm.mfg_sales_order_items
                              SET unit_price_sen = ${w.bookUnitSen}, total_sen = ${w.wantTotal},
                                  total_inc_sen = ${w.wantTotal}, balance_sen = ${w.wantTotal}
                            WHERE id = ${w.lineId} RETURNING id`;
        done.repriced += u.length;
      }
      done.headers += await applyHeader(tx, w.docNo);
    });
  }
  plain("");
  note(`APPLIED — ${done.deleted} line(s) deleted, ${done.repriced} sofa compartment(s) repriced, ${done.headers} header(s) re-summed.`);

  await sql.end({ timeout: 5 });
  await verify(armed, outboxBefore);
}

/** The header is Sigma of its lines — the same recompute
 *  repair-so-line-discount.mjs:236 and topup-ac-lines-from-truth.mjs:513
 *  perform, over the same five buckets, with `line_count` set to what the
 *  document now HOLDS rather than incremented, so a re-run cannot drift it. */
async function applyHeader(tx, docNo) {
  const rows = await tx`SELECT item_group, total_sen::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ${docNo}`;
  const b = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, service_sen: 0, others_sen: 0 };
  let total = 0;
  for (const r of rows) { total += Number(r.t); b[BUCKET[String(r.item_group)] ?? "others_sen"] += Number(r.t); }
  const u = await tx`UPDATE scm.mfg_sales_orders SET local_total_sen = ${total}, line_count = ${rows.length},
          mattress_sofa_sen = ${b.mattress_sofa_sen}, bedframe_sen = ${b.bedframe_sen},
          accessories_sen = ${b.accessories_sen}, service_sen = ${b.service_sen}, others_sen = ${b.others_sen}
        WHERE doc_no = ${docNo} RETURNING doc_no`;
  return u.length;
}

/** Every FK that points AT `scm.mfg_sales_order_items`, read from the catalogue
 *  at run time. A list typed here would go stale the first time somebody adds a
 *  table, and the failure would be silent — the three known FKs are all
 *  ON DELETE SET NULL, so a missed one unlinks a live document quietly. */
async function referencingForeignKeys() {
  return sql`
    SELECT con.conname::text AS name, ns.nspname::text AS schema, src.relname::text AS "table",
           att.attname::text AS "column", array_length(con.conkey, 1)::int AS ncols,
           con.confdeltype::text AS on_delete
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace tns ON tns.oid = tgt.relnamespace
      JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f' AND tns.nspname = 'scm' AND tgt.relname = 'mfg_sales_order_items'
     ORDER BY ns.nspname, src.relname, att.attname`;
}

async function planDelete({ book, everyBookKey, refusals }) {
  const fks = await referencingForeignKeys();
  plain("");
  plain(`── LANE delete — tables whose rows can point at a sales-order line: ${fks.length}`);
  for (const f of fks) {
    plain(`   ${f.schema}.${f.table}.${f.column}  (${f.name}, ON DELETE ${ON_DELETE[f.on_delete] ?? f.on_delete}${f.ncols > 1 ? `, COMPOSITE over ${f.ncols} columns` : ""})`);
  }

  const out = [];
  for (const t of DELETE_TARGETS) {
    const fail = [];
    if (everyBookKey.has(String(t.dtlKey))) {
      const owner = book.SO.byDtlKey.get(String(t.dtlKey));
      fail.push(`the book DOES carry DtlKey ${t.dtlKey}${owner ? ` (on ${owner.docNo})` : " on some document"} — the premise of the delete is false`);
    }
    const [hdr] = await sql`SELECT h.doc_no, h.linked_ac_docno, h.status, h.line_count::int lc,
          h.local_total_sen::bigint hdr_total, h.paid_sen::bigint paid, h.balance_sen::bigint bal
        FROM scm.mfg_sales_orders h WHERE h.company_id = ${CO} AND h.linked_ac_docno = ${t.acNo}`;
    if (!hdr) { refusals.push(`${t.acNo}: no ERP sales order claims this AutoCount number in company ${CO}`); continue; }
    const rows = await sql`SELECT i.id::text, i.line_no::int, i.item_code, i.item_group, i.qty::float8 q,
          i.unit_price_sen::bigint up, i.discount_sen::bigint disc, i.total_sen::bigint t,
          i.linked_ac_dtlkey::text k
        FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${hdr.doc_no} ORDER BY i.line_no, i.id`;
    const bookHdr = book.SO.headers.get(t.acNo);
    plain("");
    plain(`   ${t.acNo} -> ERP ${hdr.doc_no} (${hdr.status}), header ${rm(hdr.hdr_total)} over ${rows.length} row(s); the book says ${rm(bookHdr?.totalSen ?? 0)} over ${bookHdr?.lineCount ?? "?"} line(s)`);
    for (const r of rows) {
      plain(`      line ${r.line_no}  key ${r.k ?? "(none)"}  ${String(r.item_code).slice(0, 26).padEnd(26)} ${String(r.item_group).padEnd(10)} qty ${r.q}  ${rm(r.up)}  total ${rm(r.t)}${keyOf(r.k) === String(t.dtlKey) ? "   <-- THE ROW THE BOOK DOES NOT HAVE" : ""}`);
    }

    const mine = rows.filter((r) => keyOf(r.k) === String(t.dtlKey));
    if (mine.length !== 1) fail.push(`${mine.length} ERP row(s) carry DtlKey ${t.dtlKey}; exactly 1 is required`);
    const strays = rows.filter((r) => keyOf(r.k) !== String(t.dtlKey))
      .filter((r) => keyOf(r.k) === null || !everyBookKey.has(keyOf(r.k)));
    if (strays.length) {
      fail.push(`${strays.length} other ERP row(s) carry a key the book does not have (or no key at all): ` +
        strays.map((r) => `line ${r.line_no} key ${r.k ?? "(none)"}`).join(", ") +
        " — removing one row would not leave the document equal to the book");
    }
    if (mine.length === 1) {
      const composite = fks.filter((f) => f.ncols > 1);
      if (composite.length) fail.push(`${composite.length} referencing FK(s) are COMPOSITE and this sweep cannot answer them: ${composite.map((f) => `${f.schema}.${f.table}`).join(", ")}`);
      let refs = 0;
      for (const f of fks.filter((x) => x.ncols === 1)) {
        const [c] = await sql`SELECT COUNT(*)::int n FROM ${sql(f.schema)}.${sql(f.table)} WHERE ${sql(f.column)}::text = ${mine[0].id}`;
        if (Number(c.n) > 0) {
          refs += Number(c.n);
          fail.push(`${Number(c.n)} row(s) in ${f.schema}.${f.table}.${f.column} point at this line — deleting it would SILENTLY unlink them (ON DELETE ${ON_DELETE[f.on_delete] ?? f.on_delete})`);
        }
      }
      plain(`      downstream rows pointing at this line, across all ${fks.length} referencing FK(s): ${refs}`);

      /* EVERY COLUMN, captured before the delete. This printout is the recovery
         path stated in the header, and it is asserted non-empty rather than
         hoped for. */
      const [full] = await sql`SELECT * FROM scm.mfg_sales_order_items WHERE id = ${mine[0].id}`;
      if (!full || Object.keys(full).length === 0) fail.push("SELECT * returned nothing for the row — refusing to delete a row we cannot record");
      else {
        plain("");
        plain(`   CAPTURED BEFORE DELETING — every column of ${hdr.doc_no} line ${mine[0].line_no}, so it can be re-created by hand:`);
        plain(`   ${JSON.stringify(full, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
      }
      const bookTotal = bookHdr?.totalSen ?? null;
      const after = rows.filter((r) => r.id !== mine[0].id).reduce((a, r) => a + Number(r.t), 0);
      plain("");
      plain(`   after removing it the document sums to ${rm(after)}; the book says ${bookTotal == null ? "(unknown)" : rm(bookTotal)}${bookTotal != null && after === Number(bookTotal) ? "  = the same" : "  <-- STILL DIFFERS"}`);
      if (bookTotal == null) fail.push("the book states no header total for this document");
      else if (after !== Number(bookTotal)) fail.push(`removing the row leaves ${rm(after)} against the book's ${rm(bookTotal)} — the delete alone does not settle this document`);
      plain(`   paid ${rm(hdr.paid)} + header balance ${rm(hdr.bal)} = ${rm(Number(hdr.paid) + Number(hdr.bal))}; payment columns are NOT touched`);
      if (!fail.length) {
        out.push({ lane: "delete", acNo: t.acNo, docNo: hdr.doc_no, dtlKey: String(t.dtlKey), lineId: mine[0].id, bookTotal: Number(bookTotal), why: t.why });
      }
    }
    for (const f of fail) refusals.push(`${t.acNo}: ${f}`);
  }
  return out;
}

async function planSofa({ book, refusals }) {
  const out = [];
  for (const t of SOFA_PRICE_TARGETS) {
    const fail = [];
    const bl = book.SO.byDtlKey.get(String(t.dtlKey));
    if (!bl) { refusals.push(`${t.acNo}: the book has no line with DtlKey ${t.dtlKey}`); continue; }
    if (bl.docNo !== t.acNo) fail.push(`the book's DtlKey ${t.dtlKey} sits on ${bl.docNo}, not ${t.acNo}`);
    if (!bl.hasCode || !isSofaCode(bl.itemKey)) fail.push(`the book line is "${bl.itemKey}", which is not a sofa code — this lane only decides a sofa's compartments`);
    const bookHdr = book.SO.headers.get(t.acNo);
    const cv = currencyVerdict(bookHdr);
    if (cv.kind !== "local") fail.push(`the document's currency verdict is ${cv.kind}: ${cv.why}`);

    const [hdr] = await sql`SELECT h.doc_no, h.status, h.local_total_sen::bigint hdr_total,
          h.paid_sen::bigint paid, h.balance_sen::bigint bal
        FROM scm.mfg_sales_orders h WHERE h.company_id = ${CO} AND h.linked_ac_docno = ${t.acNo}`;
    if (!hdr) { refusals.push(`${t.acNo}: no ERP sales order claims this AutoCount number in company ${CO}`); continue; }
    const rows = await sql`SELECT i.id::text, i.line_no::int, i.item_code, i.item_group, i.qty::float8 q,
          i.unit_price_sen::bigint up, i.discount_sen::bigint disc, i.total_sen::bigint t,
          i.total_inc_sen::bigint ti, i.balance_sen::bigint bal, i.linked_ac_dtlkey::text k
        FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${hdr.doc_no} ORDER BY i.line_no, i.id`;
    plain("");
    plain(`── LANE sofa-price — ${t.acNo} -> ERP ${hdr.doc_no} (${hdr.status}), header ${rm(hdr.hdr_total)}; the book says ${rm(bookHdr?.totalSen ?? 0)}`);
    plain(`   the book's line: DtlKey ${bl.dtlKey} "${bl.itemKey}" qty ${bl.qty} @ ${rm(bl.unitPriceSen)} = ${rm(bl.subTotalSen)}   Desc2: ${JSON.stringify(book.SO.desc2.get(bl.dtlKey) ?? null)}`);
    for (const r of rows) {
      plain(`      line ${r.line_no}  key ${r.k ?? "(none)"}  ${String(r.item_code).slice(0, 26).padEnd(26)} ${String(r.item_group).padEnd(10)} qty ${r.q}  ${rm(r.up)}  total ${rm(r.t)}`);
    }
    const group = rows.filter((r) => keyOf(r.k) === String(t.dtlKey));
    if (group.length === 0) { refusals.push(`${t.acNo}: no ERP row carries DtlKey ${t.dtlKey}`); continue; }
    const priced = group.filter((r) => Number(r.t) !== 0 || Number(r.up) !== 0);
    plain(`   the compartment group is ${group.length} ERP row(s); ${priced.length} of them carry money, summing to ${rm(group.reduce((a, r) => a + Number(r.t), 0))} against the book's ${rm(bl.subTotalSen)}`);
    if (priced.length !== 1) {
      fail.push(`${priced.length} compartment(s) carry money; exactly 1 is required. The importer puts the price on ONE piece ` +
        "and 0.00 on its siblings (import-ac-outstanding-so.mjs `up: first ? up : 0`), so anything else is a fresh decision about which piece carries it — the owner's, not a script's.");
    } else {
      const lead = priced[0];
      if (Number(lead.disc) !== 0) fail.push(`the compartment carries a line discount of ${rm(lead.disc)} — a discount is repair-so-line-discount.mjs's subject, not this one`);
      if (Number(lead.q) !== Number(bl.qty)) fail.push(`the compartment's quantity is ${lead.q} and the book's line says ${bl.qty}; this lane moves money only, never a quantity`);
      const wantTotal = Math.round(Number(bl.unitPriceSen) * Number(lead.q));
      if (Number(lead.up) === Number(bl.unitPriceSen) && Number(lead.t) === wantTotal) {
        plain("   already at the book's price — nothing to write.");
      } else if (!fail.length) {
        const after = rows.reduce((a, r) => a + (r.id === lead.id ? wantTotal : Number(r.t)), 0);
        const bookTotal = Number(bookHdr?.totalSen ?? 0);
        plain("");
        plain(`   WRITE: ${hdr.doc_no} line ${lead.line_no} ${lead.item_code} — the compartment that ALREADY carries this sofa's money.`);
        plain(`          unit price ${rm(lead.up)} -> ${rm(bl.unitPriceSen)} (the book's own number for DtlKey ${bl.dtlKey}); line total ${rm(lead.t)} -> ${rm(wantTotal)}`);
        plain(`          its ${group.length - 1} sibling compartment(s) carry RM 0.00 and are NOT touched — the split across compartments is our internal representation and the book states nothing about it.`);
        plain(`          the document then sums to ${rm(after)}; the book says ${rm(bookTotal)}${after === bookTotal ? "  = the same" : "  <-- STILL DIFFERS"}`);
        plain(`          paid ${rm(hdr.paid)} + header balance ${rm(hdr.bal)} = ${rm(Number(hdr.paid) + Number(hdr.bal))}; payment columns are NOT touched`);
        if (after !== bookTotal) fail.push(`the write leaves ${rm(after)} against the book's ${rm(bookTotal)} — the document would still differ`);
        if (!fail.length) {
          out.push({
            lane: "sofa-price", acNo: t.acNo, docNo: hdr.doc_no, dtlKey: String(t.dtlKey), lineId: lead.id,
            lineNo: lead.line_no, itemCode: lead.item_code, qty: Number(lead.q), bookUnitSen: Number(bl.unitPriceSen),
            wantTotal, siblings: group.length - 1, bookTotal, why: t.why,
          });
        }
      }
    }
    for (const f of fail) refusals.push(`${t.acNo}: ${f}`);
  }
  return out;
}

async function outboxCount(docNos) {
  if (!docNos.length) return 0;
  const [r] = await sql`SELECT COUNT(*)::int n FROM scm.autocount_outbox WHERE doc_no = ANY(${docNos})`;
  return Number(r.n);
}

/* ── verification, on a FRESH connection, asserting the SHAPE ─────────────── */
async function verify(armed, outboxBefore) {
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const wrong = [];
  let good = 0;
  for (const w of armed) {
    const [h] = await fresh`SELECT h.doc_no, h.local_total_sen::bigint hdr, h.line_count::int lc,
          (SELECT COALESCE(SUM(x.total_sen),0)::bigint FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) AS lines_sum,
          (SELECT COUNT(*)::int FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) AS lines_n
        FROM scm.mfg_sales_orders h WHERE h.doc_no = ${w.docNo}`;
    const f = [];
    if (!h) f.push("the document is gone");
    else {
      if (Number(h.hdr) !== Number(h.lines_sum)) f.push(`header ${h.hdr} != the sum of its lines ${h.lines_sum}`);
      if (Number(h.lc) !== Number(h.lines_n)) f.push(`line_count ${h.lc} != the rows the document holds ${h.lines_n}`);
      if (Number(h.hdr) !== Number(w.bookTotal)) f.push(`header ${h.hdr} != the book's ${w.bookTotal}`);
    }
    if (w.lane === "delete") {
      /* THE SHAPE OF A DELETE: not "one row was removed" but "no row of this
         document claims that key, the row's own id is gone, and nothing
         downstream was quietly unlinked on its account". */
      const claim = await fresh`SELECT id::text FROM scm.mfg_sales_order_items
                                 WHERE doc_no = ${w.docNo} AND linked_ac_dtlkey::text = ${w.dtlKey}`;
      if (claim.length !== 0) f.push(`${claim.length} row(s) still claim DtlKey ${w.dtlKey}`);
      const still = await fresh`SELECT id::text FROM scm.mfg_sales_order_items WHERE id = ${w.lineId}`;
      if (still.length !== 0) f.push(`the row ${w.lineId} is still there`);
      const [orph] = await fresh`SELECT
            (SELECT COUNT(*)::int FROM scm.purchase_order_items WHERE so_item_id::text = ${w.lineId}) po,
            (SELECT COUNT(*)::int FROM scm.delivery_order_items WHERE so_item_id::text = ${w.lineId}) dor,
            (SELECT COUNT(*)::int FROM scm.sales_invoice_items WHERE so_item_id::text = ${w.lineId}) iv`;
      if (Number(orph.po) + Number(orph.dor) + Number(orph.iv) !== 0) f.push("a downstream row still names the deleted line");
    } else {
      const [r] = await fresh`SELECT unit_price_sen::bigint up, qty::float8 q, discount_sen::bigint disc,
            total_sen::bigint t, total_inc_sen::bigint ti, balance_sen::bigint bal, item_code
          FROM scm.mfg_sales_order_items WHERE id = ${w.lineId}`;
      if (!r) f.push("the repriced line is gone");
      else {
        if (Number(r.up) !== w.bookUnitSen) f.push(`unit_price_sen ${r.up} != the book's ${w.bookUnitSen}`);
        if (Number(r.t) !== w.wantTotal) f.push(`total_sen ${r.t} != ${w.wantTotal}`);
        if (Number(r.t) !== Math.round(Number(r.q) * Number(r.up)) - Number(r.disc)) f.push(`the ERP's own line invariant is broken: ${r.t} != ${r.q} x ${r.up} - ${r.disc}`);
        if (Number(r.ti) !== Number(r.t)) f.push(`total_inc_sen ${r.ti} != total_sen ${r.t}`);
        if (Number(r.bal) !== Number(r.t)) f.push(`balance_sen ${r.bal} != total_sen ${r.t}`);
        if (String(r.item_code) !== String(w.itemCode)) f.push(`item_code ${r.item_code} != ${w.itemCode} — the wrong compartment was written`);
      }
      const [sib] = await fresh`SELECT COUNT(*)::int n FROM scm.mfg_sales_order_items
                               WHERE doc_no = ${w.docNo} AND linked_ac_dtlkey::text = ${w.dtlKey}
                                 AND id <> ${w.lineId} AND (total_sen <> 0 OR unit_price_sen <> 0)`;
      if (Number(sib.n) !== 0) f.push(`${sib.n} sibling compartment(s) now carry money — the split was supposed to be untouched`);
    }
    if (f.length) wrong.push(`${w.docNo} (${w.lane}): ${f.join("; ")}`); else good += 1;
  }
  plain("");
  note(`VERIFIED ON A FRESH CONNECTION — ${good} of ${armed.length} target(s) read back with the SHAPE the ruling requires: ` +
    "the deleted line is claimed by nothing and named by no downstream row; the repriced compartment carries the book's unit price " +
    "and the ERP's own line invariant with its siblings still at RM 0.00; and each header equals both the sum of its lines and the book.");
  for (const x of wrong) bad(`   WRONG SHAPE ${x}`);

  for (const w of armed) {
    const [h] = await fresh`SELECT local_total_sen::bigint t, paid_sen::bigint p, balance_sen::bigint b, line_count::int lc
        FROM scm.mfg_sales_orders WHERE doc_no = ${w.docNo}`;
    if (!h) continue;
    const consistent = Number(h.t) === Number(h.p) + Number(h.b);
    note(`   ${w.docNo}  ${h.lc} line(s), total ${rm(h.t)} (book ${rm(w.bookTotal)}${Number(h.t) === Number(w.bookTotal) ? " = same" : " <-- differs"})   ` +
      `paid ${rm(h.p)} + balance ${rm(h.b)} = ${rm(Number(h.p) + Number(h.b))}${consistent ? " = the total" : "  <-- does NOT equal the total. Payment columns were NOT touched; re-deriving one is the owner's call."}`);
  }

  const [ob] = await fresh`SELECT COUNT(*)::int n FROM scm.autocount_outbox WHERE doc_no = ANY(${armed.map((w) => w.docNo)})`;
  note(`AutoCount outbox rows naming these documents, AFTER: ${ob.n} (before ${outboxBefore})${Number(ob.n) === outboxBefore ? " — unchanged, as it must be: the write-back is out of scope today" : "  <-- CHANGED, investigate"}`);
  if (Number(ob.n) !== outboxBefore) wrong.push("the AutoCount outbox moved");

  await fresh.end();
  if (wrong.length) { bad("Some targets did not read back as written — do NOT run this again until that is understood."); process.exitCode = 1; }
  plain("");
  note("No inventory movement was written and none is implied: the deleted row was a service line on migrated paperwork and the sofa change is money only. Sales-order DEMAND did not change — no quantity moved — so recompute-so-allocation.mjs is not required by this lane.");
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* already closed */ } process.exit(1); });
