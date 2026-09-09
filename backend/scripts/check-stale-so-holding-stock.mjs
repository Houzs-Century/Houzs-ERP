#!/usr/bin/env node
// Read-only: "some sales orders expired long ago and still have not shipped,
// and MRP is still assigning stock to them" — the owner, 2026-09-09.
//
// HE IS RIGHT, AND IT IS NOT A BUG IN THE ALLOCATOR — IT IS THE ABSENCE OF A
// RULE. `src/scm/lib/so-stock-allocation.ts:238` states the priority in its own
// words:
//
//     a) EFFECTIVE delivery date ASC NULLS LAST — earlier delivery wins
//     b) created_at ASC — tiebreaker so order is deterministic
//
// and the only rows it excludes are the TERMINAL statuses
// (`shared/so-terminal-states.ts`: CANCELLED, CLOSED, SHIPPED, DELIVERED,
// INVOICED, DRAFT). Nothing anywhere reads how OLD a delivery date is. So an
// order whose date passed a year ago sits at the TOP of the queue and outranks
// every live order for the same scarce item, permanently, until somebody
// cancels it by hand.
//
// WHAT THIS SCRIPT DOES AND DOES NOT DECIDE. It MEASURES the population and the
// stock it is holding. It proposes nothing and writes nothing: whether a stale
// order should stop claiming stock — and after how long, and whether it should
// drop to the BACK of the queue or leave it entirely — is a business judgement
// and belongs to the owner (CLAUDE.md: a judgement gets options, not a
// unilateral fix).
//
// EFFECTIVE DELIVERY DATE, NEVER THE ORIGINAL. `amended_delivery_date ??
// customer_delivery_date`, the same rule the allocator and mrp.ts share through
// `shared/effective-delivery.ts`. Ranking a rescheduled order by its original
// date is the exact drift that module exists to prevent, and it would make this
// report accuse orders the customer legitimately moved.
//
// "HOLDING STOCK" IS `stock_qty_ready`, NOT `qty`. A line's claim is what the
// allocator actually granted it, which is the number another order cannot have.
// Quoting the ordered quantity would overstate every partially-served line.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer including "none" — a red job reads as "the check broke".
//
// RE-RUN: safe, and it is a SNAPSHOT. The allocator runs continuously, so
// re-read it at the moment you quote it.
//
// Usage:
//   node scripts/check-stale-so-holding-stock.mjs            # 30 days overdue
//   DAYS=90 node scripts/check-stale-so-holding-stock.mjs
//   COMPANY_ID=1 SHOW=40 node scripts/check-stale-so-holding-stock.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const DAYS = Number(process.env.DAYS ?? 30);
const SHOW = Number(process.env.SHOW ?? 25);
if (!Number.isFinite(DAYS) || DAYS < 0) { console.error(`DAYS must be >= 0; got ${process.env.DAYS}`); process.exit(1); }

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* The allocator's own exclusion list. This script talks to the database
   directly rather than through the TypeScript module, so the list is restated —
   and then CHECKED against `shared/so-terminal-states.ts` at startup rather
   than trusted. A hand-copied list that silently drifts is how this repo's own
   checkers came to measure a different population from the engine they audit
   ("a checker that cannot match reports a clean run", CLAUDE.md). */
const TERMINAL = ["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"];
{
  const src = readFileSync(new URL("../src/scm/shared/so-terminal-states.ts", import.meta.url), "utf8");
  const lit = src.match(/export const SO_TERMINAL_STATES = \[([\s\S]*?)\] as const;/)?.[1];
  const theirs = lit ? [...lit.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]) : null;
  if (!theirs || !theirs.length) {
    console.error("REFUSED: could not read SO_TERMINAL_STATES from shared/so-terminal-states.ts. Nothing was read.");
    process.exit(2);
  }
  const a = [...TERMINAL].sort().join(","), b = [...theirs].sort().join(",");
  if (a !== b) {
    console.error(`REFUSED: the allocator excludes [${b}] and this check excludes [${a}]. They must be the same set or this measures a different population. Nothing was read.`);
    process.exit(2);
  }
}

async function main() {
  log(`stale sales orders still claiming stock — company ${CO}, more than ${DAYS} day(s) past their EFFECTIVE delivery date`);

  const [{ today }] = await sql`SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today`;
  log(`today (MYT): ${today.toISOString().slice(0, 10)}`);

  /* PREFLIGHT — name every column this script reads and REFUSE if one is
     absent, before the statement that would otherwise die on it.
     Bought twice on 2026-09-09, hours apart: the goods-receipt money apply set
     `updated_at` on `scm.grn_items`, which has no such column, and died `42703`
     on its first write with nothing changed (docs/bugs/0740). `stock_qty_ready`
     in particular is named by no file in `src/db/migrations-pg/` — the running
     code selects it through PostgREST, so the schema's own answer is the only
     one worth having. A raw undefined_column reads as "the check is broken";
     this reads as "the column moved, here is which". */
  const want = [
    ["mfg_sales_orders", "status"], ["mfg_sales_orders", "company_id"],
    ["mfg_sales_orders", "customer_delivery_date"], ["mfg_sales_orders", "amended_delivery_date"],
    ["mfg_sales_orders", "processing_date"], ["mfg_sales_orders", "linked_ac_docno"],
    ["mfg_sales_order_items", "cancelled"], ["mfg_sales_order_items", "stock_status"],
    ["mfg_sales_order_items", "stock_qty_ready"],
  ];
  const present = new Set((await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name IN ('mfg_sales_orders','mfg_sales_order_items')`)
    .map((r) => `${r.table_name}.${r.column_name}`));
  const gone = want.filter(([t, c]) => !present.has(`${t}.${c}`)).map(([t, c]) => `scm.${t}.${c}`);
  if (gone.length) {
    console.error(`REFUSED: ${gone.length} column(s) this check reads do not exist: ${gone.join(", ")}. Nothing was read.`);
    await sql.end();
    process.exit(2);
  }

  /* One statement. Effective delivery date = amended ?? customer, exactly as
     shared/effective-delivery.ts resolves it. */
  const rows = await sql`
    SELECT h.doc_no,
           h.status,
           h.linked_ac_docno,
           h.processing_date,
           COALESCE(h.amended_delivery_date, h.customer_delivery_date) AS eff_date,
           ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
             - COALESCE(h.amended_delivery_date, h.customer_delivery_date)::date) AS days_over,
           COUNT(*) FILTER (WHERE i.cancelled = false)                       AS lines,
           COALESCE(SUM(i.stock_qty_ready) FILTER (WHERE i.cancelled = false), 0) AS held,
           COUNT(*) FILTER (WHERE i.cancelled = false AND i.stock_status = 'READY') AS ready_lines
      FROM scm.mfg_sales_orders h
      JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
     WHERE h.company_id = ${CO}
       AND upper(h.status) <> ALL(${TERMINAL})
       AND COALESCE(h.amended_delivery_date, h.customer_delivery_date) IS NOT NULL
       AND COALESCE(h.amended_delivery_date, h.customer_delivery_date)::date
           < ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - ${DAYS}::int)
     GROUP BY h.doc_no, h.status, h.linked_ac_docno, h.processing_date, eff_date, days_over
     HAVING COALESCE(SUM(i.stock_qty_ready) FILTER (WHERE i.cancelled = false), 0) > 0
     ORDER BY held DESC, days_over DESC`;

  /* The denominator, or the count above is a number with nothing to compare it
     to. Every non-terminal order of this company that holds ANY stock. */
  const [tot] = await sql`
    SELECT COUNT(DISTINCT h.doc_no)::int AS docs,
           COALESCE(SUM(i.stock_qty_ready) FILTER (WHERE i.cancelled = false), 0)::int AS held
      FROM scm.mfg_sales_orders h
      JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
     WHERE h.company_id = ${CO}
       AND upper(h.status) <> ALL(${TERMINAL})
       AND i.cancelled = false
       AND COALESCE(i.stock_qty_ready, 0) > 0`;

  const held = rows.reduce((n, r) => n + Number(r.held), 0);
  const pct = tot.held ? ((held / tot.held) * 100).toFixed(1) : "0.0";

  log("");
  log(`ORDERS PAST THEIR DELIVERY DATE BY MORE THAN ${DAYS} DAY(S) AND STILL HOLDING STOCK: ${rows.length}`);
  log(`  units they are holding: ${held} of ${tot.held} held by all ${tot.docs} live order(s) — ${pct}%`);
  if (!rows.length) { log("  none. Nothing is being starved by a stale order at this threshold."); await sql.end(); return; }

  /* Buckets, because "overdue" covers a rescheduled order that slipped a
     fortnight and an order abandoned two years ago, and only the second one is
     what the owner is looking at. */
  const buckets = [[30, 90], [90, 180], [180, 365], [365, Infinity]];
  log("");
  log("  how far past the date            orders   units held");
  for (const [lo, hi] of buckets) {
    const b = rows.filter((r) => Number(r.days_over) > lo && Number(r.days_over) <= hi);
    if (!b.length) continue;
    const u = b.reduce((n, r) => n + Number(r.held), 0);
    const label = hi === Infinity ? `over ${lo} days` : `${lo}-${hi} days`;
    log(`  ${label.padEnd(30)} ${String(b.length).padStart(6)} ${String(u).padStart(12)}`);
  }

  /* THE OWNER'S OWN QUESTION, 2026-09-09: 「送货了就不会再里面了…因为那么久了好几
     个月前的 应该都送货了啊」. He is right that a DELIVERED order leaves the queue
     by itself — the terminal statuses above are exactly that. So an order still
     in the queue months later is one of two things, and only the second is a
     defect:

       a) genuinely not delivered — a real backlog, nothing to fix here;
       b) DELIVERED IN THE ACCOUNT BOOK AND NOT IN OURS — the delivery note
          never reached us, so our copy stays open and holds its stock for ever.

     The book settles it. `data/ac-live-so-remark2.json.gz` carries, per
     non-cancelled AutoCount sales order, an `Outstanding` flag computed as
     "some line still has Qty - TransferedQty > 0" (`export-ac-live.py`). If the
     book says a stale order has NOTHING outstanding, our copy is holding stock
     for goods that already left the warehouse.

     The snapshot is a CUT, not a live read — its own timestamp is printed, and
     an order delivered after that cut reads as still outstanding. That errs
     towards UNDER-reporting (b), which is the safe direction for a number that
     would justify releasing stock. */
  let book = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = zlib.gunzipSync(readFileSync(path.join(here, "data", "ac-live-so-remark2.json.gz"))).toString("utf8").replace(/^﻿/, "");
    book = new Map(JSON.parse(raw).map((r) => [String(r.DocNo).trim().toUpperCase(), Number(r.Outstanding)]));
    const man = JSON.parse(readFileSync(path.join(here, "data", "ac-live-export-manifest.json"), "utf8"));
    log("");
    log(`AGAINST THE ACCOUNT BOOK — cut ${man.exported_at} (+08), ${book.size} sales orders`);
  } catch (e) {
    log("");
    log(`AGAINST THE ACCOUNT BOOK — SKIPPED, the snapshot could not be read (${e.message}). The counts above stand; the delivered/not-delivered split does not.`);
  }

  if (book) {
    const withKey = rows.filter((r) => r.linked_ac_docno);
    const settled = [], open = [], absent = [];
    for (const r of withKey) {
      const v = book.get(String(r.linked_ac_docno).trim().toUpperCase());
      if (v === undefined) absent.push(r);
      else if (v === 0) settled.push(r);
      else open.push(r);
    }
    const u = (xs) => xs.reduce((n, r) => n + Number(r.held), 0);
    log(`  of the ${rows.length} stale order(s), ${withKey.length} came from the book and ${rows.length - withKey.length} were raised in the ERP (the book has no opinion on those)`);
    log(`  THE BOOK SAYS FULLY DELIVERED, and we still hold their stock: ${settled.length} order(s), ${u(settled)} unit(s)  <- work we owe`);
    log(`  the book agrees they are still outstanding:                  ${open.length} order(s), ${u(open)} unit(s)  <- a real backlog, not a defect`);
    if (absent.length) log(`  the book no longer carries the document at all:              ${absent.length} order(s), ${u(absent)} unit(s)  <- cancelled in the book, or renumbered`);
    if (settled.length) {
      log("");
      log(`  delivered in the book, still holding stock here — worst ${Math.min(SHOW, settled.length)}:`);
      for (const r of settled.slice(0, SHOW)) {
        log(`    ${r.doc_no} (${r.linked_ac_docno})  ${String(r.status).padEnd(14)} due ${String(r.eff_date).slice(0, 10)}  ${String(r.days_over).padStart(5)} days over  holding ${String(r.held).padStart(4)} unit(s)`);
      }
    }
  }

  log("");
  log(`  every stale order, worst ${Math.min(SHOW, rows.length)} by units held:`);
  for (const r of rows.slice(0, SHOW)) {
    log(`    ${r.doc_no}  ${String(r.status).padEnd(14)} due ${String(r.eff_date).slice(0, 10)}  ${String(r.days_over).padStart(5)} days over  holding ${String(r.held).padStart(4)} unit(s) over ${r.lines} line(s), ${r.ready_lines} READY${r.processing_date ? "" : "  [no processing date]"}`);
  }

  log("");
  log("This script decides nothing. Whether a stale order should stop claiming");
  log("stock, after how long, and whether it drops to the BACK of the queue or");
  log("leaves it, is the owner's call. The one row above that is NOT a judgement");
  log("is the book-says-delivered set: that is a document we are missing.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(2); });
