#!/usr/bin/env node
/* close-stale-sales-orders — close the company-1 sales orders MRP still plans
   for although nobody will deliver them any more. PLAN by default.

   OWNER, 2026-09-15:
     「开了 DO 的东西就代表已经不需要这个货了」 (rule 1)
     「这个0其实就是代表没送货的意思，是对的」 (rule 2: a DO line at qty 0 was NOT
       delivered, so rule 1 does not close it)
   He agreed to a close tool, run in batches, with a PLAN run shown to him first
   (tasks/HANDOFF-2026-09-15-mrp-stale-demand.md §3 option B).

   SCOPE. Exactly the lines the canonical MRP engine still plans for (computeMrp,
   run read-only through lib/mrp-stale-demand.mjs, the same run
   check-mrp-stale-demand.mjs reports on). Each order is put in ONE bucket by the
   pure classifier lib/stale-so-buckets.mjs — read its header for the buckets.
   Buckets 1, 3 and 4 can be closed; bucket 4 only for orders named in DOCS
   (his ticks). Bucket 2 (DO line at qty 0) and bucket 5 (undated) are report-only.

   WHAT "CLOSE" WRITES, per selected order, and nothing else:
     scm.mfg_sales_orders   status -> 'CLOSED', version + 1, updated_at = now()
                            (CAS on the status AND version the plan read: an
                            order somebody touched since is SKIPPED, never
                            overwritten)
     scm.mfg_so_status_changes  one row, as PATCH /:docNo/status writes
     scm.mfg_so_audit_log   one UPDATE_STATUS row: who (System, owner ruling
                            2026-09-15), why (bucket N + the classifier's reason)
   CLOSED is the ERP's "stop chasing the remainder" status
   (docs/modules/sales-order.md §0.1): the document stays, delivered lines and
   their DOs / invoices stand, and SO_TERMINAL_STATES takes the order out of MRP
   demand. No line is touched, cancelled or deleted.

   WHAT ELSE REACTS (read from the tree 2026-09-15, not assumed):
     AutoCount   nothing is queued. The route enqueues only on cancel or on
                 leaving DRAFT (mfg-sales-orders.ts PATCH /:docNo/status); no
                 trigger on scm.mfg_sales_orders feeds scm.autocount_outbox. The
                 book keeps the order outstanding — AutoCount is closed to staff.
     Commission  unchanged: COMMISSION_EXCLUDED_STATUSES (shared/hr-commission.ts)
                 is CANCELLED / ON_HOLD / DRAFT, so CONFIRMED and CLOSED both earn.
     Venture Portal  trg_vp_outbox_so fires on UPDATE OF status and queues one
                 pending row per order; the drain sends only while
                 app_config 'scm.venture_portal_feed' is on (printed below).
     Collection  accounting-collection.ts counts CLOSED as delivered, so an
                 order with no invoice moves to the balance stage.
     Stock       the stored per-line allocation is refreshed by the allocator,
                 which the route calls and this script does not: dispatch
                 recompute-so-allocation.yml after an apply.

   MODE=plan (default) classifies, writes the plan files and checks what the
   write depends on (the enum cast, every column written, every NOT NULL column
   an insert must name) — READ-ONLY: no row is written or locked, not even
   inside a rolled-back transaction.
   MODE=apply requires CONFIRM="CLOSE STALE SALES ORDERS" and a BUCKETS value.
   After an apply a FRESH connection re-reads every closed order and asserts the
   SHAPE: status CLOSED, version moved by exactly one, every line / quantity /
   DO line still there, one audit row — and re-runs the engine to prove none of
   their lines is still planned.

   RE-RUN: idempotent. A closed order is terminal, so the engine no longer plans
   its lines and a second run does not select it.

     DATABASE_URL  required
     MODE          plan (default) | apply
     CONFIRM       apply only: CLOSE STALE SALES ORDERS
     BUCKETS       which buckets to close, e.g. "1,3" (only 1, 3, 4 accepted)
     DOCS          optional SO numbers; restricts every bucket, and is REQUIRED
                   for bucket 4 (the owner's ticks)
     EXCLUDE       optional SO numbers never to close
     OUT_DIR       where the plan files go (default: current directory) */
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { loadBook, bookState, plannedSoLines, todayMyt } from "./lib/mrp-stale-demand.mjs";
import { BUCKETS, classifyOrder, parseBuckets, parseDocList, selectForClose } from "./lib/stale-so-buckets.mjs";
import { DO_NOT_DELIVERED_STATES } from "./lib/do-shipped-states.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "CLOSE STALE SALES ORDERS";
const COMPANY = 1;
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const fail = (m) => { console.log(GH ? `::error::${m}` : `ERROR ${m}`); process.exit(2); };
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

let buckets;
try { buckets = parseBuckets(process.env.BUCKETS); } catch (e) { fail(e.message); }
const DOCS = parseDocList(process.env.DOCS);
const EXCLUDE = parseDocList(process.env.EXCLUDE);
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) fail(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
if (APPLY && buckets.length === 0) fail("MODE=apply requires BUCKETS (e.g. 1,3)");
const OUT_DIR = process.env.OUT_DIR || ".";
const NOT_DELIVERED = DO_NOT_DELIVERED_STATES; // DRAFT, CANCELLED
const AUDIT_ACTOR = "System (close stale SO, owner ruling 2026-09-15)";

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 120 });

/** Every ERP fact the classifier and the owner's list need, for the planned lines. */
async function readFacts(db, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const batch = ids.slice(i, i + 2000);
    out.push(...await db`
      SELECT i.id::text AS id, i.doc_no, i.line_no, i.item_code, i.description, i.item_group, i.qty::float AS qty,
             i.linked_ac_dtlkey::text AS ac_key,
             h.status::text AS so_status, h.version::int AS version, h.processing_date::text AS processing,
             h.customer_delivery_date::text AS header_delivery, h.so_date::text AS so_date,
             h.linked_ac_docno AS ac_doc, h.debtor_name,
             COALESCE((SELECT count(*) FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                        WHERE di.so_item_id = i.id AND o.status::text <> ALL(${NOT_DELIVERED})), 0)::int AS live_do_lines,
             COALESCE((SELECT sum(di.qty) FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                        WHERE di.so_item_id = i.id AND o.status::text <> ALL(${NOT_DELIVERED})), 0)::float AS live_do_qty,
             COALESCE((SELECT count(*) FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                        WHERE di.so_item_id = i.id AND o.status::text = 'DRAFT'), 0)::int AS draft_do_lines,
             (SELECT string_agg(DISTINCT p.po_number || ' ' || p.status::text, ', ') FROM scm.purchase_order_items pi
                JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id WHERE pi.so_item_id = i.id) AS pos
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
       WHERE i.id::text = ANY(${batch}) AND h.company_id = ${COMPANY}`);
  }
  return out;
}

/** Order-level delivery facts: units on live DOs over the WHOLE order — lines
 *  linked by so_item_id AND DO lines that name the order only on their header
 *  (lib/do-unlinked-coverage.ts counts those too) — and the DO numbers. */
async function readOrderFacts(db, docs) {
  const out = new Map();
  for (let i = 0; i < docs.length; i += 1000) {
    const batch = docs.slice(i, i + 1000);
    const rows = await db`
      SELECT h.doc_no,
             COALESCE((SELECT sum(di.qty) FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                        WHERE o.status::text <> ALL(${NOT_DELIVERED})
                          AND (di.so_item_id IN (SELECT x.id FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no AND x.company_id = h.company_id)
                               OR (di.so_item_id IS NULL AND o.so_doc_no = h.doc_no AND o.company_id = h.company_id))), 0)::float AS live_do_qty,
             (SELECT string_agg(DISTINCT o.do_number || ' ' || o.status::text, ', ') FROM scm.delivery_orders o
               WHERE o.status::text <> 'CANCELLED' AND o.company_id = h.company_id
                 AND (o.so_doc_no = h.doc_no OR EXISTS (SELECT 1 FROM scm.delivery_order_items di JOIN scm.mfg_sales_order_items x ON x.id = di.so_item_id
                                                         WHERE di.delivery_order_id = o.id AND x.doc_no = h.doc_no))) AS dos,
             (SELECT count(*) FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no AND x.company_id = h.company_id)::int AS all_lines,
             EXISTS (SELECT 1 FROM scm.sales_invoices s WHERE s.so_doc_no = h.doc_no AND s.company_id = h.company_id) AS has_si
        FROM scm.mfg_sales_orders h
       WHERE h.doc_no = ANY(${batch}) AND h.company_id = ${COMPANY}`;
    for (const r of rows) out.set(r.doc_no, r);
  }
  return out;
}

/** The shape an order must keep through a close: lines, quantities, DO lines. */
async function shapeOf(db, docs) {
  if (!docs.length) return new Map();
  const rows = await db`
    SELECT h.doc_no, h.status::text AS status, h.version::int AS version,
           (SELECT count(*) FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no AND x.company_id = h.company_id)::int AS lines,
           (SELECT count(*) FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no AND x.company_id = h.company_id AND x.cancelled)::int AS cancelled_lines,
           (SELECT COALESCE(sum(x.qty), 0) FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no AND x.company_id = h.company_id)::float AS qty,
           (SELECT count(*) FROM scm.delivery_order_items di JOIN scm.mfg_sales_order_items x ON x.id = di.so_item_id
             WHERE x.doc_no = h.doc_no AND x.company_id = h.company_id)::int AS do_lines,
           (SELECT count(*) FROM scm.mfg_so_audit_log a WHERE a.so_doc_no = h.doc_no AND a.company_id = h.company_id
             AND a.actor_name_snapshot = ${AUDIT_ACTOR})::int AS our_audit_rows
      FROM scm.mfg_sales_orders h WHERE h.doc_no = ANY(${docs}) AND h.company_id = ${COMPANY}`;
  return new Map(rows.map((r) => [r.doc_no, r]));
}

const writeFile = (name, body) => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, name), body); return path.join(OUT_DIR, name); };
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  if (!APPLY) await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const today = await todayMyt(sql);
  notice(`=== close stale sales orders — ${APPLY ? "APPLY" : "PLAN (writes rolled back)"} · company ${COMPANY} · today ${today} (MYT) · buckets [${buckets.join(",") || "none selected"}] · docs ${DOCS.length} · exclude ${EXCLUDE.length} ===`);

  const switches = await sql`SELECT key, value FROM scm.app_config WHERE key IN ('scm.venture_portal_feed', 'scm.autocount_writeback', 'scm.migrated_so_lock', 'scm.write_freeze') ORDER BY key`;
  notice(`switches: ${switches.map((r) => `${r.key}=${JSON.stringify(r.value)}`).join(" · ") || "(none of the four rows exist)"}`);

  const book = loadBook();
  notice(`AutoCount book snapshot exported_at ${book.exportedAt}`);

  const t0 = Date.now();
  const planned = await plannedSoLines(sql, COMPANY);
  notice(`engine ran in ${Math.round((Date.now() - t0) / 1000)}s · ${planned.size} sales-order lines still planned (all companies' lines are filtered to company ${COMPANY} below)`);

  const facts = await readFacts(sql, [...planned.keys()]);
  const byDoc = new Map();
  for (const f of facts) {
    const p = planned.get(f.id);
    const l = { ...f, stock: Number(p.stock) || 0, short: Number(p.short) || 0, delivery: p.delivery ?? null, po_engine: p.po, cat: p.cat, book: bookState(book, f) };
    const o = byDoc.get(f.doc_no) ?? { doc_no: f.doc_no, customer: f.debtor_name, so_status: f.so_status, version: f.version, so_date: f.so_date, processing: f.processing, header_delivery: f.header_delivery, ac_doc: f.ac_doc, lines: [] };
    o.lines.push(l);
    byDoc.set(f.doc_no, o);
  }
  const orderFacts = await readOrderFacts(sql, [...byDoc.keys()]);

  /* Does the ERP hold the book's DO under our number? For bucket 1 that decides
     "import gap" (no) from "DO exists but is not linked to this order" (yes). */
  const bookDoNos = new Set();
  for (const o of byDoc.values()) for (const d of book.transfersBySo.get(String(o.ac_doc ?? o.doc_no.replace(/^HC-/, "")).toUpperCase()) ?? []) if (d.startsWith("DO-")) bookDoNos.add(`HC-${d}`);
  const erpDos = bookDoNos.size ? await sql`SELECT do_number, so_doc_no, status::text AS status FROM scm.delivery_orders WHERE company_id = ${COMPANY} AND do_number = ANY(${[...bookDoNos]})` : [];
  const erpDoByNo = new Map(erpDos.map((r) => [r.do_number, r]));

  const classified = [];
  for (const o of byDoc.values()) {
    const of = orderFacts.get(o.doc_no) ?? { live_do_qty: 0, dos: null, all_lines: o.lines.length, has_si: false };
    const lines = o.lines.map((l) => ({ delivery: l.delivery, liveDoLines: l.live_do_lines, liveDoQty: l.live_do_qty, draftDoLines: l.draft_do_lines, book: l.book }));
    const c = classifyOrder({ orderLiveDoQty: of.live_do_qty, lines }, today);
    const bookTransfers = book.transfersBySo.get(String(o.ac_doc ?? o.doc_no.replace(/^HC-/, "")).toUpperCase()) ?? [];
    classified.push({
      ...o, ...c, order_live_do_qty: of.live_do_qty, erp_dos: of.dos, all_lines: of.all_lines, has_si: of.has_si,
      book_transfers: bookTransfers.map((d) => { const e = erpDoByNo.get(`HC-${d}`); return e ? `${d} (ERP HC-${d} ${e.status}, SO ${e.so_doc_no ?? "-"})` : d.startsWith("DO-") ? `${d} (not in ERP)` : d; }),
      latest_delivery: o.lines.map((l) => l.delivery).filter(Boolean).sort().at(-1) ?? null,
      units: o.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
      stock: o.lines.reduce((s, l) => s + l.stock, 0),
    });
  }
  classified.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)) || String(a.latest_delivery).localeCompare(String(b.latest_delivery)) || a.doc_no.localeCompare(b.doc_no));

  /* ── the tallies ─────────────────────────────────────────────────────── */
  const LABEL = {
    [BUCKETS.BOOK_DELIVERED]: "1 AutoCount book delivered, ERP has no DO",
    [BUCKETS.DO_QTY_ZERO]: "2 line on a DO at qty 0 (owner: qty 0 = not delivered, left open)",
    [BUCKETS.HAD_DO_EXPIRED]: "3 already had a live DO, rest never delivered, expired",
    [BUCKETS.NO_DO_EXPIRED]: "4 expired, no DO at all (owner ticks)",
    [BUCKETS.UNDATED]: "5 undated (report only)",
    [BUCKETS.DRAFT_DO]: "- a planned line is on a DRAFT DO (never closed)",
    [BUCKETS.OUT_OF_SCOPE]: "- out of scope (future / mixed dates)",
  };
  const tally = (list) => ({ orders: list.length, lines: list.reduce((s, o) => s + o.lines.length, 0), units: list.reduce((s, o) => s + o.units, 0), stock: list.reduce((s, o) => s + o.stock, 0) });
  const summary = {};
  notice("BUCKETS (orders / planned lines / units / stock MRP assigns to them):");
  for (const b of Object.values(BUCKETS)) {
    const list = classified.filter((o) => o.bucket === b);
    const t = tally(list); const tc = tally(list.filter((o) => o.closable));
    summary[b] = { label: LABEL[b], ...t, closable: tc };
    say(`   ${pad(LABEL[b], 70)} orders ${pad(t.orders, 5)} lines ${pad(t.lines, 6)} units ${pad(t.units, 6)} stock ${pad(t.stock, 5)} | closable orders ${tc.orders} lines ${tc.lines} units ${tc.units} stock ${tc.stock}`);
  }
  const zeroLines = classified.reduce((s, o) => s + o.zeroQtyLines, 0);
  notice(`bucket 2 detail: ${zeroLines} planned lines sit on a live DO at qty 0 across ${classified.filter((o) => o.zeroQtyLines > 0).length} orders (all buckets) — owner: qty 0 = not delivered, left open`);

  const b1 = classified.filter((o) => o.bucket === BUCKETS.BOOK_DELIVERED);
  notice(`bucket 1 detail: ${b1.length} orders · every planned line book-delivered: ${b1.filter((o) => o.closable).length} · only some: ${b1.filter((o) => !o.closable).length}`);
  for (const o of b1) say(`   ${pad(o.doc_no, 14)} ${o.closable ? "ALL  " : "SOME "} book-delivered ${o.bookDeliveredLines}/${o.lines.length} planned lines · delivery ${o.latest_delivery ?? "-"} · ERP DOs ${o.erp_dos ?? "-"} · book ${o.book_transfers.join("; ") || "-"} · ${o.lines.map((l) => `ln${l.line_no} ${l.item_code} x${l.qty} [${l.book}]`).join("; ").slice(0, 300)}`);

  const b3 = classified.filter((o) => o.bucket === BUCKETS.HAD_DO_EXPIRED);
  notice(`bucket 3 detail: ${b3.length} orders · with a partly delivered planned line: ${b3.filter((o) => o.partialLines > 0).length}`);
  for (const o of b3) say(`   ${pad(o.doc_no, 14)} ${pad(o.so_status, 13)} delivery ${pad(o.latest_delivery, 10)} overdue ${pad(o.daysOverdue, 4)}d · DOs ${o.erp_dos ?? "-"} · ${o.lines.map((l) => `ln${l.line_no} ${l.item_code} x${l.qty}${l.live_do_qty ? ` (on DO ${l.live_do_qty})` : ""} [${l.book}]`).join("; ").slice(0, 300)}`);

  const b5 = classified.filter((o) => o.bucket === BUCKETS.UNDATED);
  const months = new Map();
  for (const o of b5) {
    const k = String(o.so_date ?? "unknown").slice(0, 7);
    const m = months.get(k) ?? { month: k, orders: 0, lines: 0, units: 0, stock: 0, with_processing: 0, so_status: {} };
    m.orders++; m.lines += o.lines.length; m.units += o.units; m.stock += o.stock; if (o.processing) m.with_processing++;
    m.so_status[o.so_status] = (m.so_status[o.so_status] ?? 0) + 1;
    months.set(k, m);
  }
  const monthRows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  notice(`bucket 5 by SO month (${b5.length} orders):`);
  for (const m of monthRows) say(`   ${m.month}  orders ${pad(m.orders, 5)} lines ${pad(m.lines, 6)} units ${pad(m.units, 6)} stock ${pad(m.stock, 5)} with processing date ${m.with_processing} · ${Object.entries(m.so_status).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  /* ── the selection ───────────────────────────────────────────────────── */
  const unknownDocs = DOCS.filter((d) => !byDoc.has(d));
  if (unknownDocs.length) notice(`DOCS not planned by MRP today (ignored): ${unknownDocs.join(", ")}`);
  const selected = selectForClose(classified, { buckets, docs: DOCS, exclude: EXCLUDE });
  const refusedTicks = DOCS.filter((d) => byDoc.has(d) && !selected.some((o) => o.doc_no === d)).map((d) => { const o = classified.find((x) => x.doc_no === d); return `${d} (bucket ${o.bucket}${o.closable ? "" : ", not closable"}${EXCLUDE.includes(d) ? ", excluded" : ""})`; });
  if (refusedTicks.length) notice(`DOCS named but NOT selected: ${refusedTicks.join(", ")}`);
  const st = tally(selected);
  notice(`SELECTED for close: ${st.orders} orders · ${st.lines} planned lines · ${st.units} units · ${st.stock} stock released back to MRP`);
  if (buckets.includes("4") && !DOCS.length) notice("bucket 4 selected without DOCS: bucket 4 closes only the orders the owner ticks, so none were selected");

  /* ── plan files (uploaded as the run artifact) ───────────────────────── */
  const plan = { mode: APPLY ? "apply" : "plan", today, company: COMPANY, snapshot: book.exportedAt, buckets, docs: DOCS, exclude: EXCLUDE, summary, bucket5_months: monthRows, selected: selected.map((o) => o.doc_no), orders: classified };
  say(`plan file: ${writeFile("close-stale-so-plan.json", JSON.stringify(plan))}`);
  const header = ["bucket", "closable", "why", "doc_no", "customer", "so_status", "so_date", "processing_date", "latest_delivery", "days_overdue", "erp_dos", "book_transfers", "line_no", "item_code", "description", "qty", "on_live_do", "on_draft_do", "stock", "book_state", "pos"];
  const csv = [header.join(",")];
  for (const o of classified) for (const l of o.lines) csv.push([o.bucket, o.closable, o.why, o.doc_no, o.customer, o.so_status, o.so_date, o.processing, o.latest_delivery, o.daysOverdue, o.erp_dos, o.book_transfers.join("; "), l.line_no, l.item_code, l.description, l.qty, l.live_do_qty, l.draft_do_lines, l.stock, l.book, l.pos].map(csvCell).join(","));
  say(`plan lines: ${writeFile("close-stale-so-lines.csv", "﻿" + csv.join("\n"))}`);

  /* ── preflight: what the apply write depends on, checked WITHOUT writing ─
     close-fee-only-sales-orders.mjs planned a clean 29 and then died on its
     first UPDATE because the enum name was wrong (run 34440869582): a plan that
     only SELECTs never touches what the write needs. So the cast, and every
     NOT NULL column without a default on the three tables written, are checked
     here in plan too — read-only, so a plan run holds no row lock and writes
     nothing, not even a rolled-back row. */
  const [{ closed }] = await sql`SELECT 'CLOSED'::scm.mfg_so_status::text AS closed`;
  const WRITES = {
    mfg_sales_orders: ["status", "version", "updated_at"],
    mfg_so_status_changes: ["doc_no", "from_status", "to_status", "changed_by", "notes", "company_id"],
    mfg_so_audit_log: ["so_doc_no", "action", "actor_name_snapshot", "source", "note", "field_changes", "status_snapshot", "company_id"],
  };
  const cols = await sql`SELECT table_name, column_name, is_nullable, column_default, data_type FROM information_schema.columns
                          WHERE table_schema = 'scm' AND table_name = ANY(${Object.keys(WRITES)})`;
  const preflight = [];
  for (const [t, named] of Object.entries(WRITES)) {
    const have = cols.filter((c) => c.table_name === t);
    for (const n of named) if (!have.some((c) => c.column_name === n)) preflight.push(`${t}.${n} does not exist`);
    if (t !== "mfg_sales_orders") for (const c of have) if (c.is_nullable === "NO" && c.column_default == null && !named.includes(c.column_name)) preflight.push(`${t}.${c.column_name} is NOT NULL with no default and the insert does not name it`);
  }
  const fc = cols.find((c) => c.table_name === "mfg_so_audit_log" && c.column_name === "field_changes");
  notice(`preflight: 'CLOSED'::scm.mfg_so_status -> ${closed} · mfg_so_audit_log.field_changes is ${fc?.data_type ?? "missing"} · ${preflight.length ? `PROBLEMS: ${preflight.join("; ")}` : "every written column exists and every required column is named"}`);
  if (closed !== "CLOSED" || preflight.length) { notice("PREFLIGHT FAILED — an apply would not write cleanly"); await sql.end(); process.exit(1); }

  if (selected.length === 0) {
    notice(`nothing selected — ${APPLY ? "nothing written" : "PLAN ONLY, nothing written"}.`);
    await sql.end();
    return;
  }
  if (!APPLY) {
    notice(`PLAN ONLY — nothing written. An apply would write ${selected.length} header status changes + ${selected.length} status-change rows + ${selected.length} audit rows. To close: MODE=apply CONFIRM="${CONFIRM_PHRASE}" with the same BUCKETS / DOCS / EXCLUDE.`);
    await sql.end();
    return;
  }

  /* ── the write: one transaction PER ORDER, so an order is never left
     closed without its trail ─────────────────────────────────────────────── */
  const before = await shapeOf(sql, selected.map((o) => o.doc_no));
  const wrote = []; const skipped = [];
  for (const o of selected) {
    await sql.begin(async (tx) => {
      const res = await tx`
        UPDATE scm.mfg_sales_orders SET status = 'CLOSED'::scm.mfg_so_status, version = version + 1, updated_at = now()
         WHERE doc_no = ${o.doc_no} AND company_id = ${COMPANY} AND status::text = ${o.so_status} AND version = ${o.version}
        RETURNING doc_no, version::int AS version`;
      if (res.length !== 1) { skipped.push(o.doc_no); return; }
      await tx`
        INSERT INTO scm.mfg_so_status_changes (doc_no, from_status, to_status, changed_by, notes, company_id)
        VALUES (${o.doc_no}, ${o.so_status}, 'CLOSED', NULL, ${`close-stale-sales-orders, owner ruling 2026-09-15, bucket ${o.bucket}`}, ${COMPANY})`;
      await tx`
        INSERT INTO scm.mfg_so_audit_log (so_doc_no, action, actor_name_snapshot, source, note, field_changes, status_snapshot, company_id)
        VALUES (${o.doc_no}, 'UPDATE_STATUS', ${AUDIT_ACTOR}, 'script',
                ${`owner ruling 2026-09-15, bucket ${o.bucket}: ${o.why}. Planned lines closed: ${o.lines.map((l) => `${l.item_code} x${l.qty}`).join(", ")}`.slice(0, 2000)},
                ${tx.json([{ field: "status", from: o.so_status, to: "CLOSED" }, { field: "version", from: o.version, to: res[0].version }])},
                'CLOSED', ${COMPANY})`;
      wrote.push(o.doc_no);
    });
  }
  notice(`WROTE: ${wrote.length} of ${selected.length} orders closed (header + status-change row + audit row each)${skipped.length ? ` · skipped (moved since the plan read): ${skipped.join(", ")}` : ""}`);
  say(`   ${wrote.join(" ")}`);
  await sql.end();

  /* ── verify on a FRESH connection, asserting the shape ───────────────── */
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 120 });
  const after = await shapeOf(check, wrote);
  const bad = [];
  for (const d of wrote) {
    const b = before.get(d); const a = after.get(d);
    if (!a) { bad.push(`${d}: gone`); continue; }
    if (a.status !== "CLOSED") bad.push(`${d}: status ${a.status}`);
    if (a.version !== b.version + 1) bad.push(`${d}: version ${b.version} -> ${a.version}`);
    if (a.lines !== b.lines || a.cancelled_lines !== b.cancelled_lines || a.qty !== b.qty || a.do_lines !== b.do_lines) bad.push(`${d}: lines/qty/DO lines changed ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    if (a.our_audit_rows !== b.our_audit_rows + 1) bad.push(`${d}: audit rows ${b.our_audit_rows} -> ${a.our_audit_rows}`);
  }
  const stillPlanned = new Set();
  const replanned = await plannedSoLines(check, COMPANY);
  const closedIds = new Set(selected.filter((o) => wrote.includes(o.doc_no)).flatMap((o) => o.lines.map((l) => l.id)));
  for (const id of replanned.keys()) if (closedIds.has(id)) stillPlanned.add(id);
  await check.end();
  notice(`VERIFY (fresh connection): ${wrote.length - bad.length} of ${wrote.length} orders CLOSED with version +1, lines / qty / DO lines unchanged and one audit row; engine still plans ${stillPlanned.size} of their ${closedIds.size} lines`);
  for (const m of bad) console.log(GH ? `::error::${m}` : `MISMATCH ${m}`);
  if (bad.length || stillPlanned.size) process.exit(1);
}

await main();
