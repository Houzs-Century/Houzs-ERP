#!/usr/bin/env node
/* Read-only: WHERE do MRP's ~5 seconds go, and would bounded concurrency move
   them? Writes nothing — SELECTs only, no DDL, no transaction.

   WHY THIS EXISTS. PR #2300 (merged 2026-08-16) fixed a correctness bug: the
   MRP demand read was truncated to 1000 of ~13,900 rows by PostgREST's
   `db-max-rows`, so the plan covered ~7% of the book. The fix pages every read,
   and its own PR body states the price it paid, in its author's words:

     "The read count goes from roughly a dozen round trips to on the order of a
      hundred ... They are sequential."

   The owner then reported the MRP page and the Sales Order list as "very
   laggy". Both measured ~5.2s against prod company 1 on 2026-08-16.

   THE HYPOTHESIS THIS PROBE EXISTS TO REFUTE.
     H: the cost is the NUMBER of sequential round trips, not the cost of any
        one query — so running the independent ones concurrently removes most
        of it, while every row still gets read.

     What would REFUTE H: any single read whose own SQL time is a large share
     of the total (then the fix is that query or an index, not concurrency), or
     a concurrent arm that fails to beat the sequential arm (then the round
     trips are not the cost, or the pool is the cost).

   WHAT IT MEASURES. Two arms over the SAME read shapes and the SAME rows:
     ARM A — sequential, exactly the order and batching computeMrp uses today.
     ARM B — the proposal: paginateAll fetches its pages in bounded parallel
             waves, and the soDeliverableRemaining chunk loop runs its chunks
             bounded-concurrently instead of one at a time.

   EQUIVALENCE IS ASSERTED, NOT ASSUMED. Both arms checksum the row set they
   actually read (sorted, so arrival order cannot flatter either arm) and the
   probe prints EQUIVALENT / DIVERGED. A faster arm that read fewer rows is the
   failure this check exists to catch — that is the whole point of the #2300
   bug it must not re-create.

   FIDELITY — the one thing this probe cannot tell you. The Worker reaches the
   database through PostgREST over HTTP; this probe speaks Postgres directly.
   So the ABSOLUTE milliseconds here are a floor, not the app's latency: every
   round trip costs the app more than it costs this probe. What transfers is
   the RATIO between the arms and the ROUND-TRIP COUNT, both of which are
   properties of the shape rather than of the transport. Read the counts as
   exact and the ms as "at least this".

   Env: DATABASE_URL (the only credential). COMPANY (default 1).
        CONCURRENCY (default 6) — arm B's bound.
   RE-RUN: idempotent. It reads; a second run reports the same shape against
        whatever the data is at that moment.

   Exit 0 for every legitimate answer (including "H refuted"). Non-zero only
   when the database cannot be reached — a red job must mean the check broke,
   not that the answer was unwelcome. */
import postgres from "postgres";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const CO = Number(process.env.COMPANY || 1);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));
/* paginateAll's own page size (backend/src/scm/lib/paginate-all.ts PAGE=1000).
   If that constant moves, this probe is measuring a shape the app no longer
   has — which is why it is named here rather than inlined as a bare 1000. */
const PAGE = 1000;
/* computeMrp's own batch size for the soDeliverableRemaining loop. */
const DOC_CHUNK = 200;

/* max must exceed CONCURRENCY or arm B queues on the client side and measures
   this probe's own pool rather than the database. */
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: CONCURRENCY + 2 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

const ms = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const fmt = (n) => `${n.toFixed(0)} ms`;

/* Run tasks with a bounded number in flight. Results keep INPUT order, so a
   caller that concatenates them gets the same sequence the sequential arm
   produces — the property that makes arm B a drop-in for arm A. */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* A stable fingerprint of a row set: sorted, so neither arm can look equivalent
   merely because it happened to arrive in the same order, and neither can look
   divergent merely because it did not. */
function checksum(ids) {
  const sorted = [...ids].sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const s of sorted) {
    for (let i = 0; i < s.length; i++) {
      h1 = ((h1 ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
      h2 = ((h2 + s.charCodeAt(i)) * 0x85ebca6b) >>> 0;
    }
  }
  return `${sorted.length}:${h1.toString(16)}${h2.toString(16)}`;
}

const EXCLUDED = SO_TERMINAL_STATES;

/* ── the read shapes, mirrored from source ───────────────────────────────────
   Each helper is ONE statement and corresponds to one PostgREST round trip the
   app makes. The filters are copied from the code named above each one; if a
   filter here drifts from the code, this probe measures a shape nothing runs.  */

// mrp.ts §1 demand — mfg_sales_order_items !inner mfg_sales_orders,
// cancelled=false, so.status NOT IN terminal, ORDER BY id, paged.
const demandPage = (offset) => sql`
  SELECT i.id::text AS id
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
   WHERE i.company_id = ${CO}
     AND i.cancelled = false
     AND UPPER(so.status::text) <> ALL(${EXCLUDED})
   ORDER BY i.id
   LIMIT ${PAGE} OFFSET ${offset}`;

// delivery-orders-mfg.ts soDeliverableRemaining step 1 — the SO lines of a
// chunk of doc_nos. This is the read PR #2300 named as duplicated work: MRP
// has already read these same lines in its demand page above.
const dlvLines = (docs, offset) => sql`
  SELECT i.id::text AS id
    FROM scm.mfg_sales_order_items i
   WHERE i.doc_no = ANY(${docs})
     AND i.cancelled = false
   ORDER BY i.line_no NULLS LAST, i.created_at, i.id
   LIMIT ${PAGE} OFFSET ${offset}`;

// soDeliverableRemaining step 1b — the SO headers, for the debtor stamp.
const dlvHeads = (docs) => sql`
  SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docs})`;

// soDeliverableRemaining step 2 — DO lines with the parent status embedded.
const dlvDoLines = (itemIds, offset) => sql`
  SELECT dli.id::text AS id
    FROM scm.delivery_order_items dli
    LEFT JOIN scm.delivery_orders dor ON dor.id = dli.delivery_order_id
   WHERE dli.so_item_id::text = ANY(${itemIds})
   ORDER BY dli.id
   LIMIT ${PAGE} OFFSET ${offset}`;

// soDeliverableRemaining step 3 — DR lines tracing back to those DO lines.
const dlvDrLines = (doLineIds) => sql`
  SELECT dri.do_item_id::text AS id
    FROM scm.delivery_return_items dri
   WHERE dri.do_item_id::text = ANY(${doLineIds})`;

/* One chunk of soDeliverableRemaining, in the app's own internal order. The
   four reads INSIDE a chunk are genuinely dependent (ids feed the next), so
   neither arm parallelises them — only the chunks themselves differ. */
async function deliverableChunk(docs, counter) {
  const ids = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await dlvLines(docs, off);
    counter.n++;
    for (const r of rows) ids.push(r.id);
    if (rows.length < PAGE) break;
  }
  await dlvHeads(docs);
  counter.n++;
  const doLineIds = [];
  if (ids.length) {
    for (let off = 0; ; off += PAGE) {
      const rows = await dlvDoLines(ids, off);
      counter.n++;
      for (const r of rows) doLineIds.push(r.id);
      if (rows.length < PAGE) break;
    }
  }
  if (doLineIds.length) {
    await dlvDrLines(doLineIds);
    counter.n++;
  }
  return ids;
}

async function main() {
  note(`probe-mrp-roundtrip-cost — company ${CO}, concurrency ${CONCURRENCY}`);
  note(`PAGE=${PAGE} (paginate-all.ts), DOC_CHUNK=${DOC_CHUNK} (mrp.ts)`);
  note(`transport: direct Postgres. The app adds PostgREST HTTP on top of EVERY`);
  note(`round trip below, so treat these ms as a FLOOR on the app's cost.\n`);

  /* ── the corpus, measured now rather than recalled from a write-up ──────── */
  const [{ n: demandRows }] = await sql`
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.company_id = ${CO} AND i.cancelled = false
       AND UPPER(so.status::text) <> ALL(${EXCLUDED})`;
  const [{ n: demandDocs }] = await sql`
    SELECT count(DISTINCT i.doc_no)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.company_id = ${CO} AND i.cancelled = false
       AND UPPER(so.status::text) <> ALL(${EXCLUDED})`;
  const [{ n: soTotal }] = await sql`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;

  const demandPages = Math.floor(demandRows / PAGE) + 1;
  const docChunks = Math.max(1, Math.ceil(demandDocs / DOC_CHUNK));
  note(`=== corpus ===`);
  note(`  sales orders (all statuses):   ${soTotal}`);
  note(`  open demand LINES:             ${demandRows}   -> ${demandPages} paginateAll pages`);
  note(`  open demand DOCS:              ${demandDocs}   -> ${docChunks} chunks of ${DOC_CHUNK}`);

  /* ── phase 1: the demand read ─────────────────────────────────────────── */
  note(`\n=== phase 1: demand read (mrp.ts section 1) ===`);
  const seqDemand = [];
  let t = ms();
  for (let p = 0; p < demandPages; p++) {
    const rows = await demandPage(p * PAGE);
    for (const r of rows) seqDemand.push(r.id);
    if (rows.length < PAGE) break;
  }
  const demandSeqMs = ms() - t;
  note(`  ARM A sequential : ${fmt(demandSeqMs)}   ${demandPages} round trips, one at a time`);

  /* Arm B: the page COUNT is known from the same total the app could ask for
     with count:'exact', so the windows can be issued together. Rows land in
     page order because mapBounded preserves input order. */
  t = ms();
  const parDemandPages = await mapBounded(
    Array.from({ length: demandPages }, (_, p) => p * PAGE),
    CONCURRENCY,
    (off) => demandPage(off),
  );
  const parDemand = parDemandPages.flatMap((rows) => rows.map((r) => r.id));
  const demandParMs = ms() - t;
  note(`  ARM B bounded-par: ${fmt(demandParMs)}   ${demandPages} round trips, ${CONCURRENCY} in flight`);
  const demandEquiv = checksum(seqDemand) === checksum(parDemand);
  note(`  rows A=${seqDemand.length} B=${parDemand.length}  ${demandEquiv ? "EQUIVALENT" : "DIVERGED <- arm B did not read the same rows"}`);

  /* ── phase 2: the soDeliverableRemaining chunk loop ────────────────────── */
  const docRows = await sql`
    SELECT DISTINCT i.doc_no
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.company_id = ${CO} AND i.cancelled = false
       AND UPPER(so.status::text) <> ALL(${EXCLUDED})
     ORDER BY i.doc_no`;
  const docs = docRows.map((r) => r.doc_no);
  const chunks = [];
  for (let i = 0; i < docs.length; i += DOC_CHUNK) chunks.push(docs.slice(i, i + DOC_CHUNK));

  note(`\n=== phase 2: soDeliverableRemaining loop (mrp.ts section 1, batched 200) ===`);
  const seqCounter = { n: 0 };
  t = ms();
  const seqIds = [];
  for (const ch of chunks) seqIds.push(...(await deliverableChunk(ch, seqCounter)));
  const dlvSeqMs = ms() - t;
  note(`  ARM A sequential : ${fmt(dlvSeqMs)}   ${seqCounter.n} round trips, one at a time`);

  const parCounter = { n: 0 };
  t = ms();
  const parIdChunks = await mapBounded(chunks, CONCURRENCY, (ch) => deliverableChunk(ch, parCounter));
  const parIds = parIdChunks.flat();
  const dlvParMs = ms() - t;
  note(`  ARM B bounded-par: ${fmt(dlvParMs)}   ${parCounter.n} round trips, ${CONCURRENCY} chunks in flight`);
  const dlvEquiv = checksum(seqIds) === checksum(parIds);
  note(`  rows A=${seqIds.length} B=${parIds.length}  ${dlvEquiv ? "EQUIVALENT" : "DIVERGED <- arm B did not read the same rows"}`);

  /* ── phase 3: is any ONE read the cost? the refutation check ───────────── */
  note(`\n=== phase 3: per-read cost (would refute "it is the round trips") ===`);
  const singles = [
    ["demand page 0", () => demandPage(0)],
    ["mfg_products category walk", () => sql`SELECT category FROM scm.mfg_products WHERE company_id = ${CO} ORDER BY id LIMIT ${PAGE}`],
    ["inventory_balances page 0", () => sql`SELECT product_code, warehouse_id, variant_key, qty FROM scm.inventory_balances WHERE company_id = ${CO} ORDER BY product_code, warehouse_id, variant_key, company_id LIMIT ${PAGE}`],
    ["warehouses", () => sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO} AND is_active = true ORDER BY code`],
    ["state_warehouse_mappings", () => sql`SELECT state, warehouse_id FROM scm.state_warehouse_mappings WHERE company_id = ${CO}`],
  ];
  let slowest = 0;
  for (const [label, run] of singles) {
    const t0 = ms();
    let n = 0;
    try {
      n = (await run()).length;
    } catch (e) {
      warn(`  ${label.padEnd(30)} FAILED: ${e.message}`);
      continue;
    }
    const dt = ms() - t0;
    slowest = Math.max(slowest, dt);
    note(`  ${label.padEnd(30)} ${fmt(dt).padStart(9)}   ${n} rows`);
  }

  /* ── the verdict ──────────────────────────────────────────────────────── */
  const totalSeq = demandSeqMs + dlvSeqMs;
  const totalPar = demandParMs + dlvParMs;
  const totalTrips = demandPages + seqCounter.n;
  note(`\n=== verdict ===`);
  note(`  round trips in these two phases:  ${totalTrips}`);
  note(`  ARM A (today)     : ${fmt(totalSeq)}`);
  note(`  ARM B (proposed)  : ${fmt(totalPar)}`);
  const equivalent = demandEquiv && dlvEquiv;
  if (!equivalent) {
    warn(`  EQUIVALENCE FAILED — arm B read a different row set. The speedup is`);
    warn(`  not usable and the proposal must not ship. This is the #2300 bug class.`);
  } else if (totalPar < totalSeq) {
    const saved = totalSeq - totalPar;
    note(`  saving           : ${fmt(saved)} at the SQL layer (${(100 * saved / totalSeq).toFixed(0)}%), same rows`);
    note(`  H SUPPORTED: the sequential round trips are the cost, and bounding`);
    note(`  concurrency removes them without reading less.`);
  } else {
    warn(`  H REFUTED: concurrency did not help here. Do not ship the restructure`);
    warn(`  on this evidence — look at the individual queries instead.`);
  }
  note(`  slowest single read: ${fmt(slowest)} — if this is a large share of the`);
  note(`  total above, the cost is that QUERY (an index), not the round trips.`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
