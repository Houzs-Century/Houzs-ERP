#!/usr/bin/env node
/* stamp-conversion-line-keys — give our delivery order, goods receipt, invoice
 * and purchase order lines the AutoCount line key the book itself pairs them with.
 *
 * 白话. 我们开的 DO / GR 已经进了 AutoCount，可是 ERP 没记下每一行对应账本的哪一行，
 * 所以之后一改，整张单就被拦住不送。账本的 DocTransfer 表写着每一行是从 SO / PO 的哪一行
 * 转过来的（从销售单转出去的采购单，写在采购单那一行自己身上）；这个脚本照账本的记录，
 * 把账本的行号写回我们的行上。对不上或分不清的，只列出来，
 * 不写。只写行号这一栏，不碰数量、价钱、库存、状态，也不会送任何东西去 AutoCount。
 *
 * ── WHY (docs/bugs/0897) ───────────────────────────────────────────────────
 * The drain stores a converted document's line keys from what the host returns,
 * and the host returns no source line. So it compared item codes, which a
 * conversion copies from the SOURCE line — 'AK-BASTION MATT (Q)' in the book,
 * 'AKEMI BASTION MATT (Q)' in the ERP — and refused. Measured on production
 * 2026-09-14: 82 ERP-created delivery orders (417 lines) and 64 goods receipts
 * (244 lines) in the book with at least one keyless line, and an edit of any of
 * them is refused whole (KeylessLineError).
 *
 * INVOICES (docs/bugs/0914). A sales invoice converted from a delivery order and
 * a purchase invoice converted from a goods receipt keep no keys for the same
 * reason: HC-SI-2609-001 reached the book whole on 2026-09-10, all eight ERP
 * lines keyless, and its edit was never sent. Their source is the DO / GR line
 * (`sales_invoice_items.do_item_id`, `purchase_invoice_items.grn_item_id`),
 * paired against the book's DocTransfer exactly like a DO against its SO.
 *
 * CARRIED-OVER DOCUMENTS (docs/bugs/0919). A delivery order or purchase order
 * carried over from AutoCount is in the snapshot under AutoCount's own number
 * (DO-010936) when export-ac-conversion-line-keys.py was given it, and in the
 * ERP as "HC-" + that number, linked to it. No write-back conversion ever sent
 * it, so instead of a SENT row the plan requires that link: the ERP document
 * must carry that very AutoCount number (and a delivery order the carried-over
 * flag). The pairing rule, the digest and the verify are unchanged.
 *
 * PURCHASE ORDERS (docs/bugs/0903). A purchase order raised from a sales order
 * kept no keys either (0890), and some were sent with each line's quantity and
 * cost under another line's key (0889). Their values can only be corrected by an
 * edit that names each line by its own key, so the keys come first.
 *
 * ── THE PAIRING ────────────────────────────────────────────────────────────
 * `lib/conversion-line-key-plan.mjs`, self-tested before a row is read: inside
 * ONE document, the book line whose DocTransfer source key equals the source key
 * of our row (`delivery_order_items.so_item_id` -> that sales line's
 * `linked_ac_dtlkey`; `grn_items.purchase_order_item_id` -> that purchase line's;
 * `purchase_order_items.so_item_id` -> that sales line's, against the book's
 * `PODTL.FromSODtlKey`).
 * No position, no item code. A source key feeding two lines of the document is
 * refused — unless ONE row carries that source and the book lines add up to its
 * quantity with nothing downstream holding them (docs/bugs/0915): the row takes
 * the first line, and the rest are named for retire-book-only-conversion-lines.
 * A row already carrying a different key is reported and left.
 *
 * ── WHAT IT WRITES, AND WHAT IT CANNOT TOUCH ───────────────────────────────
 * One column on five tables, only where it is NULL:
 *     scm.delivery_order_items.linked_ac_dtlkey
 *     scm.grn_items.linked_ac_dtlkey
 *     scm.sales_invoice_items.linked_ac_dtlkey
 *     scm.purchase_invoice_items.linked_ac_dtlkey
 *     scm.purchase_order_items.linked_ac_dtlkey
 * No quantity, price, cost, status or stock, and no outbox row — nothing is
 * sent to AutoCount. Triggers were READ on production 2026-09-14 (`pg_trigger`):
 * `delivery_order_items` fires only on DELETE or `UPDATE OF delivery_order_id`,
 * `grn_items` carries no user trigger, and the one trigger on
 * `purchase_order_items`, `trg_po_item_qty_guard`, fires only on `UPDATE OF qty`
 * (read the same way, 2026-09-14), so this UPDATE fires none. Neither
 * `sales_invoice_items` nor `purchase_invoice_items` carries a user trigger
 * (`pg_trigger`, read 2026-09-15).
 *
 * ── THE SNAPSHOT ───────────────────────────────────────────────────────────
 * `data/ac-conversion-line-keys.json.gz`, written by
 * `export-ac-conversion-line-keys.py` on a machine that reaches the office
 * network (the Actions runner cannot). Refused when older than
 * MAX_SNAPSHOT_AGE_DAYS: a key paired from a stale book is not proved.
 * Only book documents numbered `HC-DO-` / `HC-GRN-` / `HC-SI-` / `HC-PI-` /
 * `HC-PO-` are in it, and a document is planned only when a SENT so_to_do /
 * po_to_gr / do_to_iv / gr_to_pi / so_to_po outbox row names it; a purchase
 * order the write-back CREATED has no source to pair by. A snapshot cut before
 * the invoice lanes existed simply holds no invoice lines.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan and writes nothing. Apply needs CONFIRM and the
 * PLAN_DIGEST the plan run printed, so a database that moved in between refuses
 * instead of writing a stale plan. The writes run in one transaction; each names
 * one row by id AND re-asserts that its key is still NULL and its source pointer
 * unchanged, and if any of them matches no row the whole transaction is rolled
 * back. The result is re-read on a FRESH connection and every planned row must
 * carry exactly the planned key.
 *
 * RE-RUN: a no-op once applied. A second run re-plans, finds every stamped row
 * `already_correct`, writes nothing, and prints an empty digest.
 *
 * Env: DATABASE_URL (required)   MODE=plan|apply (default plan)
 *      CONFIRM (apply only)      PLAN_DIGEST (apply only, from the plan run)
 *      COMPANY_ID (default 1)    MAX_SNAPSHOT_AGE_DAYS (default 2)   SHOW (default 200)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { IS_REFUSAL, IS_WRITE, planDocumentKeys, runSelfTest, tallyOutcomes } from "./lib/conversion-line-key-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "stamp the book line keys on our purchase orders, delivery orders, receipts and invoices";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const MAXAGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = Number(process.env.SHOW || 200);

const say = (m) => console.log(m);
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const selfTest = runSelfTest();
if (selfTest.length) {
  console.error(`the pairing rule failed its own self-test, so nothing is planned: ${selfTest.join("; ")}`);
  process.exit(3);
}
say("pairing rule self-test: PASS");

/* ── the snapshot ─────────────────────────────────────────────────────────── */
const snapPath = path.join(here, "data", "ac-conversion-line-keys.json.gz");
if (!fs.existsSync(snapPath)) {
  console.error("data/ac-conversion-line-keys.json.gz is not in the tree — run export-ac-conversion-line-keys.py on a machine that reaches the office network");
  process.exit(3);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const age = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(age <= MAXAGE)) {
  console.error(`the snapshot is ${age.toFixed(1)} days old (limit ${MAXAGE}) — refusing rather than pairing keys from an old book`);
  process.exit(3);
}
const F = Object.fromEntries(snap.fields.map((f, i) => [f, i]));
say(`snapshot: cut ${snap.exported_at} (${age.toFixed(2)} days old), ${snap.rows.length} book lines`);

const bookByDoc = new Map();
for (const r of snap.rows) {
  const k = `${r[F.docType]}|${r[F.docNo]}`;
  const list = bookByDoc.get(k) ?? [];
  list.push({ toDtlKey: r[F.toDtlKey], fromDtlKey: r[F.fromDtlKey], qty: "qty" in F ? r[F.qty] : null, transferredOn: "transferredOn" in F ? r[F.transferredOn] : null });
  bookByDoc.set(k, list);
}
const docNos = (t) => [...bookByDoc.keys()].filter((k) => k.startsWith(`${t}|`)).map((k) => k.slice(t.length + 1));
/* A book number the write-back minted IS the ERP number; a carried-over one is
   AutoCount's own, and the ERP holds it as "HC-" + that number. */
const carriedOver = (bookNo) => !String(bookNo).startsWith("HC-");
const erpNumberOf = (bookNo) => (carriedOver(bookNo) ? `HC-${bookNo}` : bookNo);

/* ── the ERP side ─────────────────────────────────────────────────────────── */
const LANES = {
  DO: { table: "delivery_order_items", sourceCol: "so_item_id", op: "so_to_do" },
  GR: { table: "grn_items", sourceCol: "purchase_order_item_id", op: "po_to_gr" },
  IV: { table: "sales_invoice_items", sourceCol: "do_item_id", op: "do_to_iv" },
  PI: { table: "purchase_invoice_items", sourceCol: "grn_item_id", op: "gr_to_pi" },
  PO: { table: "purchase_order_items", sourceCol: "so_item_id", op: "so_to_po" },
};
const TYPES = Object.keys(LANES);

async function readLanes(sql) {
  const doRows = await sql`
    SELECT d.do_number AS doc_no, d.linked_ac_docno AS linked_docno, d.migrated_no_stock AS carried_flag,
           i.id::text AS id, i.linked_ac_dtlkey, i.qty::float AS qty, i.so_item_id::text AS source_row,
           s.linked_ac_dtlkey AS source_key
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items i ON i.delivery_order_id = d.id
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
     WHERE d.company_id = ${CO} AND d.do_number IN ${sql(docNos("DO").map(erpNumberOf))}`;
  const grRows = await sql`
    SELECT g.grn_number AS doc_no, i.id::text AS id, i.linked_ac_dtlkey, i.qty_accepted::float AS qty, i.purchase_order_item_id::text AS source_row,
           p.linked_ac_dtlkey AS source_key
      FROM scm.grns g
      JOIN scm.grn_items i ON i.grn_id = g.id
      LEFT JOIN scm.purchase_order_items p ON p.id = i.purchase_order_item_id
     WHERE g.company_id = ${CO} AND g.grn_number IN ${sql(docNos("GR"))}`;
  const ivRows = docNos("IV").length ? await sql`
    SELECT s.invoice_number AS doc_no, i.id::text AS id, i.linked_ac_dtlkey, i.qty::float AS qty, i.do_item_id::text AS source_row,
           d.linked_ac_dtlkey AS source_key
      FROM scm.sales_invoices s
      JOIN scm.sales_invoice_items i ON i.sales_invoice_id = s.id
      LEFT JOIN scm.delivery_order_items d ON d.id = i.do_item_id
     WHERE s.company_id = ${CO} AND s.invoice_number IN ${sql(docNos("IV"))}` : [];
  const piRows = docNos("PI").length ? await sql`
    SELECT p.invoice_number AS doc_no, i.id::text AS id, i.linked_ac_dtlkey, i.qty::float AS qty, i.grn_item_id::text AS source_row,
           g.linked_ac_dtlkey AS source_key
      FROM scm.purchase_invoices p
      JOIN scm.purchase_invoice_items i ON i.purchase_invoice_id = p.id
      LEFT JOIN scm.grn_items g ON g.id = i.grn_item_id
     WHERE p.company_id = ${CO} AND p.invoice_number IN ${sql(docNos("PI"))}` : [];
  const poRows = await sql`
    SELECT p.po_number AS doc_no, p.linked_ac_docno AS linked_docno, true AS carried_flag,
           i.id::text AS id, i.linked_ac_dtlkey, i.qty::float AS qty, i.so_item_id::text AS source_row,
           s.linked_ac_dtlkey AS source_key
      FROM scm.purchase_orders p
      JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
     WHERE p.company_id = ${CO} AND p.po_number IN ${sql(docNos("PO").map(erpNumberOf))}`;
  const sent = await sql`
    SELECT op, ac_doc_no FROM scm.autocount_outbox
     WHERE company_id = ${CO} AND status = 'sent' AND op IN ('so_to_do', 'po_to_gr', 'do_to_iv', 'gr_to_pi', 'so_to_po')
       AND ac_doc_no IN ${sql(TYPES.flatMap(docNos))}`;
  return { DO: doRows, GR: grRows, IV: ivRows, PI: piRows, PO: poRows, sent: new Set(sent.map((s) => `${s.op}|${s.ac_doc_no}`)) };
}

function plan(lanes) {
  const writes = [];
  const planned = [];
  const docs = { planned: 0, not_in_erp: [], not_sent_by_writeback: [], carried_over: 0, not_linked: [] };
  const refusals = [];
  let unclaimed = 0;
  const merged = [];
  for (const type of TYPES) {
    const lane = LANES[type];
    const byDoc = new Map();
    for (const r of lanes[type]) {
      const list = byDoc.get(r.doc_no) ?? [];
      list.push(r);
      byDoc.set(r.doc_no, list);
    }
    for (const docNo of docNos(type)) {
      const rows = byDoc.get(erpNumberOf(docNo));
      if (!rows) { docs.not_in_erp.push(`${type} ${docNo}`); continue; }
      if (carriedOver(docNo)) {
        /* No conversion sent it; the ERP document must name this very AutoCount
           document instead, and a delivery order must be flagged carried over. */
        if (!rows.every((r) => r.linked_docno === docNo && r.carried_flag === true)) { docs.not_linked.push(`${type} ${docNo}`); continue; }
        docs.carried_over += 1;
      } else if (!lanes.sent.has(`${lane.op}|${docNo}`)) { docs.not_sent_by_writeback.push(`${type} ${docNo}`); continue; }
      docs.planned += 1;
      const result = planDocumentKeys(
        rows.map((r) => ({ id: r.id, linkedKey: r.linked_ac_dtlkey, sourceKey: r.source_key, qty: r.qty })),
        bookByDoc.get(`${type}|${docNo}`),
      );
      unclaimed += result.unclaimedBookLines.length;
      if (result.rows.some((x) => x.outcome === "stamp_merged")) {
        merged.push(`${type} ${docNo}: book line(s) ${result.unclaimedBookLines.join(", ")} left for retire-book-only-conversion-lines once stamped`);
      }
      const sourceRowOf = new Map(rows.map((r) => [r.id, r.source_row]));
      for (const p of result.rows) {
        planned.push({ ...p, type });
        if (IS_WRITE.has(p.outcome)) writes.push({ type, table: lane.table, sourceCol: lane.sourceCol, id: p.id, dtlKey: p.dtlKey, sourceRow: sourceRowOf.get(p.id) ?? null, docNo });
        if (IS_REFUSAL.has(p.outcome)) refusals.push(`${type} ${docNo}: ${p.outcome} (source key ${p.sourceKey ?? "-"})`);
      }
    }
  }
  writes.sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
  const digest = writes.length
    ? crypto.createHash("sha256").update(writes.map((w) => `${w.table}:${w.id}:${w.dtlKey}:${w.sourceRow}`).join("\n")).digest("hex").slice(0, 16)
    : "";
  return { writes, planned, docs, refusals, unclaimed, merged, digest };
}

function report(p) {
  for (const type of TYPES) {
    const t = tallyOutcomes(p.planned.filter((x) => x.type === type));
    notice(`${type} rows: ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  notice(`documents planned: ${p.docs.planned} (${p.docs.carried_over} carried over from AutoCount); in the book but not in the ERP: ${p.docs.not_in_erp.length}; no SENT conversion row: ${p.docs.not_sent_by_writeback.length}; carried-over number not linked: ${p.docs.not_linked.length}; book lines no row of ours claims: ${p.unclaimed}`);
  for (const d of p.docs.not_linked.slice(0, SHOW)) say(`  carried over but not linked to that AutoCount number: ${d}`);
  for (const d of p.docs.not_in_erp.slice(0, SHOW)) say(`  not in the ERP: ${d}`);
  for (const d of p.docs.not_sent_by_writeback.slice(0, SHOW)) say(`  no sent conversion row: ${d}`);
  for (const r of p.refusals.slice(0, SHOW)) say(`  refused: ${r}`);
  for (const m of p.merged.slice(0, SHOW)) say(`  split in the book: ${m}`);
  const byDoc = new Map();
  for (const w of p.writes) byDoc.set(`${w.type} ${w.docNo}`, (byDoc.get(`${w.type} ${w.docNo}`) ?? 0) + 1);
  for (const [d, n] of [...byDoc.entries()].slice(0, SHOW)) say(`  would stamp: ${d} — ${n} line(s)`);
  notice(`PLAN DIGEST ${p.digest || "(nothing to write)"} — ${p.writes.length} line key(s) to stamp`);
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const lanes = await readLanes(sql);
const p = plan(lanes);
report(p);

if (!APPLY) {
  notice(`PLAN: nothing written. Apply with MODE=apply CONFIRM='${CONFIRM_PHRASE}' PLAN_DIGEST=${p.digest || "<none>"}`);
  await sql.end();
  process.exit(0);
}
if (!p.writes.length) { notice("APPLY: nothing to write."); await sql.end(); process.exit(0); }
if ((process.env.PLAN_DIGEST || "").trim() !== p.digest) {
  console.error(`PLAN_DIGEST ${JSON.stringify(process.env.PLAN_DIGEST ?? "")} does not match this run's plan ${p.digest} — the book or the database moved since the plan; re-plan`);
  await sql.end();
  process.exit(2);
}

try {
  await sql.begin(async (tx) => {
    for (const w of p.writes) {
      /* Table and column names come from LANES, a constant of this file, never
         from the snapshot or the database; every value is bound. */
      const res = await tx`UPDATE ${tx("scm." + LANES[w.type].table)} SET linked_ac_dtlkey = ${w.dtlKey}
                    WHERE id = ${w.id} AND company_id = ${CO} AND linked_ac_dtlkey IS NULL
                      AND ${tx(LANES[w.type].sourceCol)}::text IS NOT DISTINCT FROM ${w.sourceRow}`;
      if (res.count !== 1) throw new Error(`${w.type} ${w.docNo} row ${w.id} matched ${res.count} rows — it moved since the plan; nothing is kept`);
    }
  });
} catch (e) {
  console.error(`APPLY rolled back: ${e.message}`);
  await sql.end();
  process.exit(1);
}
await sql.end();

/* Re-read on a FRESH connection and compare VALUES: every planned row must now
   carry exactly the key it was planned to take. A count would say "N updated"
   while a wrong key sat on one of them. */
const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const ids = (t) => p.writes.filter((w) => w.type === t).map((w) => w.id);
const back = [];
for (const t of TYPES) {
  if (!ids(t).length) continue;
  back.push(...await verify`SELECT id::text AS id, linked_ac_dtlkey FROM ${verify("scm." + LANES[t].table)} WHERE id::text IN ${verify(ids(t))}`);
}
await verify.end();
const now = new Map(back.map((r) => [r.id, r.linked_ac_dtlkey]));
const wrong = p.writes.filter((w) => typeof now.get(w.id) === "undefined" || Number(now.get(w.id)) !== Number(w.dtlKey));
if (wrong.length) {
  console.error(`verify FAILED on ${wrong.length} row(s), e.g. ${JSON.stringify(wrong.slice(0, 3))}`);
  process.exit(1);
}
notice(`APPLIED: ${p.writes.length} line key(s) stamped and verified on a fresh connection. Nothing was sent to AutoCount; a refused edit of these documents can now be re-queued.`);
