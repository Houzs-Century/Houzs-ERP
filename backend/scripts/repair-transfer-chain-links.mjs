#!/usr/bin/env node
/* repair-transfer-chain-links — point every migrated child line at the parent
 * LINE the account book itself names.
 *
 * 白话. 账本其实有写「这一行是从哪一行转过来的」，我们一直没读到那张表，所以
 * 56 张单的上下游对不上。现在照账本一行一行接回去；账本没写的、或者我们这边分
 * 不出是哪一行的，就留空并且列出来，不猜。
 *
 * ── WHAT CHANGED, AND WHY THIS IS NOT A HEURISTIC ──────────────────────────
 * Every checker here was built on *"AutoCount records which DOCUMENT a line came
 * from and NEVER which line"*. That is true of the DETAIL TABLES — the six
 * `FromDocDtlKey` columns are NULL on all ~220,000 rows — and FALSE of the book.
 * AutoCount keeps the line graph in `DocTransfer`: 134,501 rows, both line keys
 * set on every one, exactly one source per child. `export-ac-doc-transfer.mjs`
 * pulls it and re-asserts that shape at every export.
 *
 * So nothing here is inferred from item codes, quantities or positions. Position
 * pairing is what put two identical bedframes on the wrong receipts
 * (docs/bugs/0690); an item-code rule would have mis-linked `GR-004940`, where
 * the book names purchase line `829688` and the only code-matching line on that
 * order is `829690`.
 *
 * The ONE place a choice remains is our own decomposition — a sofa is one line
 * in the book and one row per compartment here — and `lib/transfer-link-plan.mjs`
 * resolves it by compartment code INSIDE the single book line the book already
 * chose, refusing when that does not separate. Its rule is self-tested before a
 * row is read and this script REFUSES on a failure.
 *
 * ── WHAT IT WRITES, AND WHAT IT CANNOT TOUCH ───────────────────────────────
 * Four provenance pointers and NOTHING else:
 *
 *     scm.purchase_order_items.so_item_id
 *     scm.grn_items.purchase_order_item_id
 *     scm.delivery_order_items.so_item_id
 *     scm.purchase_invoice_items.grn_item_id
 *
 * No quantity, no price, no cost, no status, no stock. 「库存先不看」 is respected
 * by construction and the triggers were READ rather than reasoned about
 * (`pg_trigger` on production, 2026-09-09): `delivery_order_items` fires only on
 * DELETE or `UPDATE OF delivery_order_id`; `mfg_sales_order_items` only on
 * DELETE; `purchase_order_items` only on `UPDATE OF qty`; and `grn_items`,
 * `grns` and `purchase_invoice_items` carry no user trigger at all. None of the
 * four columns above is any of those, so no trigger fires.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan. Apply needs CONFIRM and needs the PLAN DIGEST computed
 * at plan time, so a book or a database that moved in between refuses instead of
 * writing a stale plan. Every UPDATE names one row by id AND re-asserts the
 * parent pointer it was planned against, so a link written by anyone in between
 * is left alone rather than overwritten.
 *
 * RE-RUN: a no-op. A second run re-resolves, finds every planned row already
 * pointing where the book says, classifies it `already_correct` and writes
 * nothing.
 *
 * Env: DATABASE_URL (required)   MODE=plan|apply (default plan)
 *      CONFIRM (apply only, must be 'align the transfer chain to the book')
 *      PLAN_DIGEST (apply only, from the plan run)
 *      COMPANY_ID (default 1)    TYPES (default PO,GR,DO,PI)
 *      MAX_SNAPSHOT_AGE_DAYS (default 2)   SHOW (default 400 rows per section)
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveOne, runSelfTest, tally, IS_REFUSAL, OUTCOMES } from "./lib/transfer-link-plan.mjs";
import { fromVerdictFor, sourceDocTokens, IS_DIFFERENCE } from "./lib/transfer-chain-verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "align the transfer chain to the book";
const CO = Number(process.env.COMPANY_ID || 1);
const MAXAGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = Number(process.env.SHOW || 400);
const WANT_TYPES = (process.env.TYPES || "PO,GR,DO,PI").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const say = (m) => console.log(m);
const U = (s) => String(s ?? "").trim().toUpperCase();

/* ── THE RESOLVER IS SELF-TESTED BEFORE A ROW IS READ ─────────────────────── */
const selfTest = runSelfTest();
if (selfTest.length) {
  console.error(`the link resolver failed its own self-test, so nothing is planned: ${selfTest.join("; ")}`);
  process.exit(3);
}
say(`link resolver self-test: PASS`);

/* ── THE TWO SNAPSHOTS ────────────────────────────────────────────────────── */
function loadSnap(file, label) {
  const p = path.join(here, "data", file);
  if (!fs.existsSync(p)) { console.error(`${file} is not in the tree — refresh it on a machine that can reach the office network`); process.exit(3); }
  const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
  const age = (Date.now() - new Date(s.exported_at).getTime()) / 86400000;
  if (!(age <= MAXAGE)) {
    console.error(`${label} is ${age.toFixed(1)} days old (limit ${MAXAGE}) — refusing rather than writing links from an old book`);
    process.exit(3);
  }
  say(`${label}: cut ${s.exported_at} (${age.toFixed(2)} days old)`);
  return s;
}
const edgesSnap = loadSnap("ac-convert-edges.json.gz", "the chain snapshot");
const xferSnap = loadSnap("ac-doc-transfer.json.gz", "the line-graph snapshot");

/* The line graph, as child key -> source line key. The exporter has already
   PROVED there is at most one source per child; this asserts it again here
   rather than letting a `set` silently keep the last one. */
const SOURCE_OF = new Map();
for (const e of xferSnap.edges) {
  const to = String(e[3]);
  if (SOURCE_OF.has(to) && SOURCE_OF.get(to) !== String(e[1])) {
    console.error(`the line graph names two different sources for child line ${to} — refusing`);
    process.exit(3);
  }
  SOURCE_OF.set(to, String(e[1]));
}
say(`the book's line graph: ${SOURCE_OF.size} child line(s) with a named source line`);

const L = Object.fromEntries(edgesSnap.line_fields.map((n, i) => [n, i]));
const BOOK = {};
for (const [t, payload] of Object.entries(edgesSnap.types || {})) {
  const cancelled = new Set();
  const H = Object.fromEntries(edgesSnap.header_fields.map((n, i) => [n, i]));
  for (const r of payload.headers || []) if (r[H.cancelled] === "T") cancelled.add(r[H.docNo]);
  const byKey = new Map();
  for (const r of payload.lines || []) {
    byKey.set(String(r[L.dtlKey]), {
      docNo: r[L.docNo], dtlKey: String(r[L.dtlKey]),
      fromDocType: r[L.fromDocType] || "", fromDocNo: r[L.fromDocNo] || "",
      fromSoDtlKey: r[L.fromSoDtlKey] || "",
    });
  }
  BOOK[t] = { lines: byKey, cancelled };
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* ── ONE EDGE PER CHILD TYPE ────────────────────────────────────────────────
   Written out per type. A table or column name composed from a caller's string
   is one typo away from a statement that matches nothing and reads as a clean
   run — the failure `check-ac-transfer-counters.mjs` refuses by construction.

   `sourceKeyOf` says where the BOOK states this edge's source LINE:
     · PO  — `PODTL.FromSODtlKey`, which the chain snapshot already carries.
             AutoCount does not put the SO->PO edge in `DocTransfer` at all.
     · the rest — `DocTransfer`, keyed by our own child line key. */
const EDGES = {
  PO: {
    label: "purchase order line -> the sales-order line it was raised from",
    column: "scm.purchase_order_items.so_item_id",
    sourceKeyOf: (bookLine) => String(bookLine.fromSoDtlKey || ""),
    children: () => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS child_key,
             i.so_item_id::text AS current_parent, h.linked_ac_docno AS ac_no,
             h.po_number AS erp_no, sh.linked_ac_docno AS parent_doc_now
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
        LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
       WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NOT NULL`,
    parents: (keys) => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS line_key,
             COALESCE(h.linked_ac_docno, '') AS doc_no
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
       WHERE i.company_id = ${CO} AND i.linked_ac_dtlkey::text = ANY(${keys})`,
    write: (id, parentId, wasParent) => (wasParent
      ? sql`UPDATE scm.purchase_order_items SET so_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND so_item_id = ${wasParent}::uuid`
      : sql`UPDATE scm.purchase_order_items SET so_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND so_item_id IS NULL`),
  },
  GR: {
    label: "goods-receipt line -> the purchase-order line it was raised from",
    column: "scm.grn_items.purchase_order_item_id",
    sourceKeyOf: (bookLine) => SOURCE_OF.get(bookLine.dtlKey) || "",
    children: () => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS child_key,
             i.purchase_order_item_id::text AS current_parent,
             g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
             g.grn_number AS erp_no, pp.linked_ac_docno AS parent_doc_now
        FROM scm.grn_items i
        JOIN scm.grns g ON g.id = i.grn_id
        JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
        LEFT JOIN scm.purchase_order_items pi2 ON pi2.id = i.purchase_order_item_id
        LEFT JOIN scm.purchase_orders pp ON pp.id = pi2.purchase_order_id
       WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
         AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL
         AND i.linked_ac_dtlkey IS NOT NULL`,
    parents: (keys) => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS line_key,
             COALESCE(h.linked_ac_docno, '') AS doc_no
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
       WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey::text = ANY(${keys})`,
    write: (id, parentId, wasParent) => (wasParent
      ? sql`UPDATE scm.grn_items SET purchase_order_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND purchase_order_item_id = ${wasParent}::uuid`
      : sql`UPDATE scm.grn_items SET purchase_order_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND purchase_order_item_id IS NULL`),
  },
  DO: {
    label: "delivery-order line -> the sales-order line it was raised from",
    column: "scm.delivery_order_items.so_item_id",
    sourceKeyOf: (bookLine) => SOURCE_OF.get(bookLine.dtlKey) || "",
    children: () => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS child_key,
             i.so_item_id::text AS current_parent, h.linked_ac_docno AS ac_no,
             h.do_number AS erp_no, sh.linked_ac_docno AS parent_doc_now
        FROM scm.delivery_order_items i
        JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
        LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
       WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NOT NULL`,
    parents: (keys) => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS line_key,
             COALESCE(h.linked_ac_docno, '') AS doc_no
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
       WHERE i.company_id = ${CO} AND i.linked_ac_dtlkey::text = ANY(${keys})`,
    write: (id, parentId, wasParent) => (wasParent
      ? sql`UPDATE scm.delivery_order_items SET so_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND so_item_id = ${wasParent}::uuid`
      : sql`UPDATE scm.delivery_order_items SET so_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND so_item_id IS NULL`),
  },
  PI: {
    label: "purchase-invoice line -> the goods-receipt line it was raised from",
    column: "scm.purchase_invoice_items.grn_item_id",
    sourceKeyOf: (bookLine) => SOURCE_OF.get(bookLine.dtlKey) || "",
    children: () => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS child_key,
             i.grn_item_id::text AS current_parent, h.linked_ac_docno AS ac_no,
             h.invoice_number AS erp_no,
             COALESCE(g.linked_ac_gr_docno, p.linked_ac_docno) AS parent_doc_now
        FROM scm.purchase_invoice_items i
        JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
        LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
        LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${CO}
        LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
       WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NOT NULL`,
    parents: (keys) => sql`
      SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS line_key,
             COALESCE(g.linked_ac_gr_docno, '') AS doc_no
        FROM scm.grn_items i
        JOIN scm.grns g ON g.id = i.grn_id
       WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
         AND i.linked_ac_dtlkey::text = ANY(${keys})`,
    write: (id, parentId, wasParent) => (wasParent
      ? sql`UPDATE scm.purchase_invoice_items SET grn_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND grn_item_id = ${wasParent}::uuid`
      : sql`UPDATE scm.purchase_invoice_items SET grn_item_id = ${parentId}::uuid
             WHERE id = ${id}::uuid AND grn_item_id IS NULL`),
  },
};

/** The transfer-from verdict the TALLY gives this row today. Imported, never restated. */
function currentVerdict(row, bookLine) {
  return fromVerdictFor({
    bookFromDocType: bookLine.fromDocType,
    bookFromDocNo: bookLine.fromDocNo,
    bookFromLineKey: bookLine.fromSoDtlKey,
    erpHasLink: !!row.current_parent,
    erpParentDocNo: row.parent_doc_now ?? null,
    erpParentLineKey: null,
  });
}

async function buildPlan() {
  const plan = [];
  const report = [];
  for (const t of WANT_TYPES) {
    const e = EDGES[t];
    if (!e) { say(`  ${t}: no edge is declared for this type — skipped`); continue; }
    const B = BOOK[t];
    if (!B) { say(`  ${t}: the chain snapshot carries no ${t} lines — skipped`); continue; }

    const kids = await e.children();
    /* ONLY the rows the tally LOCKS. A repair that also rewrote rows nobody
       reported would be changing a population the owner never asked about. */
    const locked = [];
    for (const r of kids) {
      const bl = B.lines.get(String(r.child_key ?? "").trim());
      if (!bl) continue;
      if (B.cancelled.has(bl.docNo)) continue;
      const v = currentVerdict(r, bl);
      if (!IS_DIFFERENCE.has(v)) continue;
      locked.push({ r, bl, v });
    }

    /* the parent rows, read ONCE for every source line the book names */
    const keys = [...new Set(locked.map(({ bl }) => e.sourceKeyOf(bl)).filter(Boolean))];
    const parentRows = keys.length ? await e.parents(keys) : [];
    const byKey = new Map();
    for (const p of parentRows) {
      const k = String(p.line_key ?? "").trim();
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ id: p.id, itemCode: p.item_code, docNo: p.doc_no });
    }

    const resolutions = [];
    for (const { r, bl, v } of locked) {
      const srcKey = e.sourceKeyOf(bl);
      const res = resolveOne(
        { id: r.id, itemCode: r.item_code, currentParentId: r.current_parent, bookSourceLineKey: srcKey },
        byKey.get(String(srcKey)) || [],
      );
      /* BELT AND BRACES. Even a resolved parent must sit on a document the book
         NAMES for this line. A link that agrees with the line graph but not with
         `FromDocNo` would be a contradiction, and a contradiction is a finding. */
      if (res.outcome === "link") {
        const p = (byKey.get(String(srcKey)) || []).find((x) => x.id === res.parentId);
        const named = sourceDocTokens(bl.fromDocNo);
        if (named.length && !named.includes(U(p?.docNo))) {
          resolutions.push({ r, bl, v, res: {
            outcome: "ambiguous", parentId: null,
            why: `the line graph points at line ${srcKey} on ${p?.docNo}, but the book's own FromDocNo for this line says ${bl.fromDocNo} — the two halves of the book disagree, so nothing is written`,
          } });
          continue;
        }
      }
      resolutions.push({ r, bl, v, res });
      if (res.outcome === "link") {
        plan.push({
          t, id: r.id, parentId: res.parentId, wasParent: r.current_parent || null,
          acNo: r.ac_no, erpNo: r.erp_no, itemCode: r.item_code,
          childKey: String(r.child_key), sourceKey: String(srcKey), was: v,
        });
      }
    }
    report.push({ t, e, locked: locked.length, resolutions, kids: kids.length });
  }
  return { plan, report };
}

const { plan, report } = await buildPlan();

/* The DIGEST is over the planned writes in a stable order, so a book or a
   database that moved between plan and apply produces a different one and the
   apply refuses instead of writing a stale plan. */
const planKey = (p) => `${p.t}|${p.id}|${p.parentId}|${p.wasParent ?? ""}`;
const digest = crypto.createHash("sha256")
  .update(plan.map(planKey).sort().join("\n")).digest("hex").slice(0, 16);

say("");
say("═════════ WHAT THE BOOK SAYS, AND WHAT WE HOLD ═════════");
let totalRefused = 0;
const refusedDocs = new Set();
for (const { t, e, locked, resolutions, kids } of report) {
  const tl = tally(resolutions.map((x) => x.res));
  const docs = new Set(resolutions.map((x) => x.r.ac_no));
  say("");
  say(`── ${t} — ${e.label}`);
  say(`   column: ${e.column}`);
  say(`   ${kids} keyed ERP line(s) read; ${locked} on ${docs.size} document(s) are what the tally LOCKS on the transfer-from axis`);
  for (const o of OUTCOMES) if (tl[o]) say(`      ${String(tl[o]).padStart(4)}  ${o}`);
  const refused = resolutions.filter((x) => IS_REFUSAL.has(x.res.outcome));
  totalRefused += refused.length;
  for (const x of refused) refusedDocs.add(`${t} ${x.r.ac_no}`);
  let shown = 0;
  for (const x of resolutions) {
    if (x.res.outcome === "no_source_in_book" || x.res.outcome === "already_correct") continue;
    if (shown++ >= SHOW) { say(`      ... ${resolutions.length - shown} more (raise SHOW)`); break; }
    const mark = IS_REFUSAL.has(x.res.outcome) ? "REFUSE " : "LINK   ";
    say(`      ${mark} ${x.r.ac_no} (${x.r.erp_no}) ${x.r.item_code} [was ${x.v}]`);
    say(`               ${x.res.why}`);
  }
}

/* ── WHAT THIS CLOSES, PER DOCUMENT ────────────────────────────────────────
   The tally counts DOCUMENTS, not lines, and a document stays locked while ONE
   of its lines still differs. So a link count is not the answer to "how many
   documents does this close" and must never be printed as if it were. */
say("");
say("═════════ WHAT THIS CLOSES, COUNTED THE WAY THE TALLY COUNTS ═════════");
const closes = []; const stays = [];
for (const { t, resolutions } of report) {
  const byDoc = new Map();
  for (const x of resolutions) {
    if (x.res.outcome === "no_source_in_book") continue;
    const k = `${t} ${x.r.ac_no}`;
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k).push(x);
  }
  for (const [k, xs] of byDoc) {
    const left = xs.filter((x) => IS_REFUSAL.has(x.res.outcome));
    if (left.length === 0) closes.push(k);
    else stays.push({ k, left });
  }
}
say(`   CLOSES ${closes.length} document(s) on the transfer-from axis:`);
for (const k of closes.sort()) say(`      ${k}`);
say("");
say(`   STILL DIFFERS on ${stays.length} document(s), and here is exactly why:`);
for (const s of stays.sort((a, b) => a.k.localeCompare(b.k))) {
  say(`      ${s.k} — ${s.left.length} line(s) unresolved`);
  for (const x of s.left.slice(0, 4)) say(`          ${x.r.item_code}: ${x.res.why}`);
}

say("");
say("═════════ THE PLAN ═════════");
say(`   ${plan.length} link(s) to write, over ${new Set(plan.map((p) => `${p.t} ${p.acNo}`)).size} document(s)`);
say(`   ${totalRefused} line(s) left BLANK on ${refusedDocs.size} document(s) — named above, never guessed`);
say(`   PLAN DIGEST: ${digest}`);
say(`   nothing else is touched: no quantity, no price, no cost, no status, no stock`);

if (!APPLY) {
  say("");
  say("MODE=plan — nothing was written. To apply:");
  say(`   MODE=apply CONFIRM='${CONFIRM_PHRASE}' PLAN_DIGEST=${digest}`);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

if (process.env.PLAN_DIGEST !== digest) {
  console.error(`PLAN_DIGEST is '${process.env.PLAN_DIGEST}' and this run plans '${digest}'.`);
  console.error("The book or the database moved since the plan. Re-run the plan and read it before applying — refusing.");
  await sql.end({ timeout: 5 });
  process.exit(4);
}

say("");
say("═════════ APPLYING ═════════");
let wrote = 0; let skipped = 0;
for (const p of plan) {
  const res = await EDGES[p.t].write(p.id, p.parentId, p.wasParent);
  if (res.count === 1) wrote += 1;
  else { skipped += 1; say(`   left alone: ${p.t} ${p.acNo} ${p.itemCode} — the row's parent pointer changed since the plan`); }
}
say(`   wrote ${wrote}, left alone ${skipped}`);

/* ── VERIFICATION, ON A FRESH CONNECTION, ASSERTING THE SHAPE ──────────────
   A row count is not a shape. What has to be true afterwards is that every row
   we wrote points at a line carrying the AutoCount line key the BOOK named, on a
   document the book NAMES for it — which is the thing the tally will re-measure. */
await sql.end({ timeout: 5 });
const check = postgres(DST, { ssl: "require", prepare: false, max: 1,
  connection: { default_transaction_read_only: "on" } });

const VERIFY = {
  PO: (ids) => check`
    SELECT i.id::text AS id, si.linked_ac_dtlkey::text AS parent_key, sh.linked_ac_docno AS parent_doc
      FROM scm.purchase_order_items i
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
     WHERE i.id::text = ANY(${ids})`,
  GR: (ids) => check`
    SELECT i.id::text AS id, pi2.linked_ac_dtlkey::text AS parent_key, pp.linked_ac_docno AS parent_doc
      FROM scm.grn_items i
      LEFT JOIN scm.purchase_order_items pi2 ON pi2.id = i.purchase_order_item_id
      LEFT JOIN scm.purchase_orders pp ON pp.id = pi2.purchase_order_id
     WHERE i.id::text = ANY(${ids})`,
  DO: (ids) => check`
    SELECT i.id::text AS id, si.linked_ac_dtlkey::text AS parent_key, sh.linked_ac_docno AS parent_doc
      FROM scm.delivery_order_items i
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
     WHERE i.id::text = ANY(${ids})`,
  PI: (ids) => check`
    SELECT i.id::text AS id, gi.linked_ac_dtlkey::text AS parent_key, g.linked_ac_gr_docno AS parent_doc
      FROM scm.purchase_invoice_items i
      LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
      LEFT JOIN scm.grns g ON g.id = gi.grn_id
     WHERE i.id::text = ANY(${ids})`,
};

say("");
say("═════════ VERIFICATION — fresh connection, SHAPE not count ═════════");
let bad = 0; let good = 0;
for (const t of WANT_TYPES) {
  const mine = plan.filter((p) => p.t === t);
  if (!mine.length) continue;
  const rows = await VERIFY[t](mine.map((p) => p.id));
  const got = new Map(rows.map((r) => [r.id, r]));
  for (const p of mine) {
    const r = got.get(p.id);
    const wantKey = String(p.sourceKey);
    if (!r) { bad += 1; say(`   MISSING  ${t} ${p.acNo} ${p.itemCode} — the row could not be re-read`); continue; }
    if (String(r.parent_key ?? "") !== wantKey) {
      bad += 1;
      say(`   WRONG    ${t} ${p.acNo} ${p.itemCode} — points at line ${r.parent_key ?? "nothing"}, the book says ${wantKey}`);
      continue;
    }
    if (!U(r.parent_doc)) {
      bad += 1;
      say(`   UNSTAMPED ${t} ${p.acNo} ${p.itemCode} — the parent document carries no AutoCount number`);
      continue;
    }
    good += 1;
  }
}
say(`   ${good} row(s) verified at the book's own line key; ${bad} did NOT hold the shape`);
await check.end({ timeout: 5 });
if (bad) { console.error("the shape check failed — see the rows above"); process.exit(5); }
say("");
say("DONE. Every written link points at the line the account book names.");
