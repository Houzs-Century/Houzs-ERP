#!/usr/bin/env node
/* check-doc-no-reissue.mjs — READ-ONLY. Does any ERP document number exist
   TWICE, and has the monthly counter ever re-issued a number it already gave
   out?
   ===========================================================================

   WHY THIS EXISTS. On 2026-08-20 AutoCount refused four documents with
   `Primary Key Error` — HC-SO-2608-001, HC-SO-2608-002 and HC-PO-2608-001 were
   already in the AED_HOUZS book, written there on 2026-08-14/17
   (backend/scripts/data/ac-live-proof.json). The ERP had minted them a SECOND
   time. Document numbers are minted `max(suffix)+1` over the rows that still
   exist for the month (scm/lib/doc-no.ts), so deleting the newest row of a
   month hands its number back to the next create.

   The rejected sync is the SMALL question. The large one is whether two LIVE
   ERP documents share a number right now, which no outbox can answer. That is
   section A, and it runs first.

   ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
   (A) DUPLICATES — every doc-number column in scm/public, grouped, any value
       held by 2+ rows. This is the question. An empty A is the good answer.
   (B) UNIQUE INDEX CENSUS — which of those columns the DATABASE will refuse a
       duplicate on. A column with a unique index CANNOT be in A; a column
       WITHOUT one is protected by nothing but the minter, and belongs on the
       owner's list whether or not it is dirty today.
   (C) SERIES CENSUS — per company-prefix + type + YYMM: rows, highest suffix,
       and the GAPS below it. A gap is a deleted document. Gaps below the max
       are harmless (max+1 steps over them); the counter only re-issues when the
       deletion takes the TOP of the series, and that leaves no trace in the
       table at all — which is exactly why section D exists.
   (D) RE-ISSUE, MEASURED — the numbers AutoCount is known to hold, from
       ac-live-proof.json, each with the ERP row that carries it TODAY and when
       that row was created. An ERP row created AFTER the date the book received
       that number is a re-issue, proven by two timestamps rather than a story.
   (E) OUTBOX MEMORY — what scm.autocount_outbox still knows about those
       numbers. The queue is the ERP's only record of what it has exported, and
       it is on golive-wipe-hc.mjs's CLEAR list, so a wipe erases the evidence
       along with the documents.
   (G) COUNTER SEED PREVIEW — what scm.doc_number_counters holds today (or
       that it is ABSENT), and what a seed migration WOULD write per series:
       the live max, the outbox max, and the account book's max, with the
       highest of the three winning. The series it RAISES past the surviving
       rows are listed on their own — that set is the entire risk of a seed.
   (F) CREATED-AT INVERSIONS — a lower suffix created LATER than a higher one in
       the same series. Not proof on its own (a backfill or restore reorders
       created_at too), but it is the shape a re-issue leaves when the re-minted
       document is later joined by the higher numbers again.

   ── HOW IT FINDS THE COLUMNS ───────────────────────────────────────────────
   DISCOVERED from information_schema, not hardcoded. A hand-written list is a
   copy that goes stale the first time a document type is added — and the whole
   point of A is to be exhaustive. The candidate column NAMES are the ones the
   minters in scm/routes/*.ts actually write (mintMonthlyDocNo's 3rd argument);
   anything matching in a live base table is checked, and REG below records
   which of them a minter is known to own, so a discovered column with no known
   minter is reported rather than silently trusted.

   Strictly read-only: SELECTs only, no DDL, no writes, no transaction, manual
   trigger only. Exits 0 for every legitimate answer INCLUDING duplicates found
   — the output is the answer and a red job would read as "the check broke".
   Only an unreachable database exits non-zero.
     DATABASE_URL   required (env, or .dev.vars for local use)
     SAMPLE_LIMIT   rows per duplicate value to print (default 6)
     SERIES_MONTHS  how many recent YYMM series to print in C (default 3)
   =========================================================================== */
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT || 6);
const SERIES_MONTHS = Number(process.env.SERIES_MONTHS || 3);

const ident = /^[a-z_][a-z0-9_]*$/;
const qi = (s) => {
  if (!ident.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

/* Column names the monthly minters write. Each is `mintMonthlyDocNo(sb, table,
   COL, ...)`'s third argument at a real call site — grep mintMonthlyDocNo in
   backend/src/scm/routes to re-derive. `je_no` comes from nextJeNo, the 4-pad
   sibling minter at the foot of doc-no.ts. */
const DOC_COLS = [
  "doc_no", "po_number", "do_number", "grn_number", "invoice_number",
  "return_number", "pv_number", "pc_number", "take_no", "transfer_no",
  "trip_no", "je_no", "quote_no", "quotation_no", "receive_number",
];

/* The minters we KNOW own a column, so a discovered column with no entry here
   is reported as unattributed rather than assumed safe. "schema.table.column"
   -> the route file that mints it. */
const REG = new Map(Object.entries({
  "scm.mfg_sales_orders.doc_no": "mfg-sales-orders.ts:1024 (SO)",
  "scm.purchase_orders.po_number": "mfg-purchase-orders.ts:1215 (PO)",
  "scm.delivery_orders.do_number": "delivery-orders-mfg.ts:390 (DO)",
  "scm.grns.grn_number": "grns.ts:1834 (GRN)",
  "scm.purchase_invoices.invoice_number": "purchase-invoices.ts:82 (PI)",
  "scm.sales_invoices.invoice_number": "sales-invoices.ts:270 (SI)",
  "scm.payment_vouchers.pv_number": "payment-vouchers.ts:106 (PV)",
  "scm.delivery_returns.return_number": "delivery-returns.ts:109 (DR)",
  "scm.purchase_returns.return_number": "purchase-returns.ts:67 (PRT)",
  "scm.stock_takes.take_no": "stock-takes.ts:110 (STK)",
  "scm.stock_transfers.transfer_no": "stock-transfers.ts:61 (ST)",
  "scm.trips.trip_no": "trips.ts:101 / delivery-planning.ts:2222 (TRIP, cross-company)",
  "scm.consignment_sales_orders.doc_no": "consignment-orders.ts:200 (CS)",
  "scm.consignment_delivery_orders.do_number": "consignment-notes.ts:168 (CN)",
  "scm.consignment_delivery_returns.return_number": "consignment-returns.ts:116 (CRN)",
  "scm.purchase_consignment_orders.pc_number": "purchase-consignment-orders.ts:342 (PCO)",
  "scm.purchase_consignment_returns.return_number": "purchase-consignment-returns.ts:231 (PCT)",
  "scm.purchase_consignment_receives.receive_number": "purchase-consignment-receives.ts:824 (PCR)",
  "scm.journal_entries.je_no": "doc-no.ts:203 nextJeNo (JE, 4-pad)",
}));

/* The numbers the licensed AED_HOUZS book is KNOWN to hold, with the date it
   received them. Transcribed from backend/scripts/data/ac-live-proof.json —
   the only hand-maintained record of what has actually reached the book. If a
   number here maps to an ERP row created AFTER that date, the ERP re-issued it.
   Entries whose note says the book got AutoCount's OWN number (DO-011260,
   PO-009968) are deliberately excluded: those never came from our counter. */
const AC_HELD = [
  ["HC-SO-2608-001", "2026-08-14", "create_so"],
  ["HC-SO-2608-002", "2026-08-14", "create_so"],
  ["HC-DO-2608-001", "2026-08-17", "so_to_do"],
  ["HC-DO-2608-002", "2026-08-17", "so_to_do"],
  ["HC-SI-2608-001", "2026-08-17", "do_to_iv"],
  ["HC-PO-2608-001", "2026-08-17", "so_to_po"],
  ["HC-GR-2608-001", "2026-08-17", "po_to_gr"],
  ["HC-PI-2608-001", "2026-08-17", "gr_to_pi"],
];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* `<prefix->TYPE-YYMM-NNN`. The prefix is the company's (HC-, 2990-) or absent
   for the pre-2026-08-07 HOUZS bare numbers and the cross-company TRIP series.
   Splitting on the LAST two dashes is what keeps `2990-SO-2608-001` and
   `SO-2608-001` in different series without needing to know the company list. */
function parseDocNo(s) {
  const m = /^(.*?)([A-Z]+)-(\d{4})-(\d+)$/.exec(String(s ?? "").trim());
  if (!m) return null;
  return { prefix: m[1], type: m[2], yymm: m[3], n: parseInt(m[4], 10), width: m[4].length };
}

let exitCode = 0;

try {
  log("=== check-doc-no-reissue (READ-ONLY) ===");
  log(`    ${new Date().toISOString()}`);

  const companies = await pg`SELECT id, code, name FROM public.companies ORDER BY id`;
  log("");
  log("--- companies ---");
  for (const r of companies) log(`  id=${r.id}  code=${r.code}  name=${r.name}`);

  // ── Discover the doc-number columns that actually exist ──────────────────
  const found = await pg`
    SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema
       AND tb.table_name = c.table_name
       AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('scm', 'public')
       AND c.column_name = ANY(${DOC_COLS})
     ORDER BY c.table_schema, c.table_name, c.column_name`;

  // Which of them carry created_at / company_id, for sections C/D/F.
  const extra = await pg`
    SELECT table_schema AS s, table_name AS t, column_name AS c
      FROM information_schema.columns
     WHERE table_schema IN ('scm', 'public')
       AND column_name IN ('created_at', 'company_id', 'status')`;
  const has = new Map();
  for (const r of extra) {
    const k = `${r.s}.${r.t}`;
    if (!has.has(k)) has.set(k, new Set());
    has.get(k).add(r.c);
  }
  const hasCol = (s, t, c) => has.get(`${s}.${t}`)?.has(c) === true;

  /* Sample columns for printing an offending row. `id` is NOT universal —
     public.order_details and the ac_snapshot_* mirrors key on the document
     number itself — and assuming it crashed this script's first production run
     with `column "id" does not exist`. Build the list from what the table
     actually has, and always include the doc-number column so a row is
     identifiable even when nothing else is available. */
  const sampleCols = (s, t, c) => {
    const out = [];
    if (hasCol(s, t, "id")) out.push("id");
    out.push(c);
    for (const k of ["company_id", "status", "created_at"]) if (hasCol(s, t, k)) out.push(k);
    return [...new Set(out)];
  };

  log("");
  log(`--- doc-number columns discovered: ${found.length} ---`);
  const unattributed = [];
  for (const r of found) {
    const key = `${r.s}.${r.t}.${r.c}`;
    const owner = REG.get(key);
    if (!owner) unattributed.push(key);
    log(`  ${key}${owner ? `   <- ${owner}` : "   <- (no known minter)"}`);
  }
  const registered = new Set(REG.keys());
  const discovered = new Set(found.map((r) => `${r.s}.${r.t}.${r.c}`));
  const missingFromDb = [...registered].filter((k) => !discovered.has(k));
  if (missingFromDb.length) {
    log("");
    warn(`  ${missingFromDb.length} column(s) a minter writes but this DB does not have: ${missingFromDb.join(", ")}`);
  }

  /* ═════ (A) DUPLICATES — THE QUESTION ═════════════════════════════════════
     One grouped SELECT per column. A doc number held by two rows is a
     data-integrity fault regardless of how it got there, so this asks the
     table directly rather than reasoning from the constraint census in B. */
  log("");
  log("=== (A) DUPLICATE DOCUMENT NUMBERS ===");
  let dupColumns = 0;
  let dupValues = 0;
  let dupExtraRows = 0;
  const dirty = new Map(); // "s.t.c" -> number of duplicated values
  for (const r of found) {
    const S = qi(r.s), T = qi(r.t), C = qi(r.c);
    const dups = await pg`
      SELECT ${pg(C)} AS doc_no, count(*)::int AS n
        FROM ${pg(S)}.${pg(T)}
       WHERE ${pg(C)} IS NOT NULL AND btrim(${pg(C)}::text) <> ''
       GROUP BY ${pg(C)}
      HAVING count(*) > 1
       ORDER BY count(*) DESC, ${pg(C)}
       LIMIT 200`;
    if (!dups.length) continue;
    dupColumns += 1;
    dupValues += dups.length;
    dirty.set(`${r.s}.${r.t}.${r.c}`, dups.length);
    for (const d of dups) dupExtraRows += d.n - 1;
    warn(`  DUPLICATES in ${r.s}.${r.t}.${r.c} — ${dups.length} number(s) held by more than one row`);
    for (const d of dups.slice(0, 50)) {
      warn(`      ${d.doc_no}  x${d.n}`);
      // Print the offending rows so the owner can see WHICH documents they are.
      const cols = sampleCols(r.s, r.t, r.c);
      const rows = await pg`
        SELECT ${pg(cols.map(qi))}
          FROM ${pg(S)}.${pg(T)}
         WHERE ${pg(C)} = ${d.doc_no}
         ORDER BY 1
         LIMIT ${SAMPLE_LIMIT}`;
      for (const x of rows) {
        warn(`          ${cols.map((k) => `${k}=${x[k] ?? "-"}`).join("  ")}`);
      }
    }
  }
  if (dupColumns === 0) {
    log(`  NONE. ${found.length} doc-number column(s) checked, zero numbers held by more than one row.`);
  } else {
    warn(`  TOTAL: ${dupValues} duplicated number(s) across ${dupColumns} column(s); ${dupExtraRows} extra row(s).`);
  }

  /* ═════ (B) UNIQUE INDEX CENSUS ═══════════════════════════════════════════
     What the DATABASE enforces, read from pg_index rather than from the
     migrations — a migration says what was intended on the day it was written.
     A single-column, non-partial unique index is the only shape that makes A
     impossible; a partial one leaves the excluded rows unprotected. */
  log("");
  log("=== (B) UNIQUE-INDEX CENSUS (what the database itself refuses) ===");
  /* LEFT JOIN, not JOIN, and coalesce to '(expr)': an EXPRESSION index column
     has attnum 0 and no pg_attribute row, so an inner join would DROP it and
     make `unique (doc_no, lower(other))` look like a single-column unique index
     on doc_no — a false "protected". indisvalid/indisready are carried because
     an invalid index (a failed CREATE INDEX CONCURRENTLY) enforces nothing. */
  const idx = await pg`
    SELECT n.nspname AS s,
           t.relname AS t,
           i.relname AS idx,
           ix.indpred IS NOT NULL AS is_partial,
           (ix.indisvalid AND ix.indisready) AS is_live,
           array_agg(coalesce(a.attname, '(expr)') ORDER BY k.ord) AS cols
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname IN ('scm', 'public') AND ix.indisunique
     GROUP BY n.nspname, t.relname, i.relname, ix.indpred, ix.indisvalid, ix.indisready`;
  const idxByTable = new Map();
  for (const r of idx) {
    const k = `${r.s}.${r.t}`;
    if (!idxByTable.has(k)) idxByTable.set(k, []);
    idxByTable.get(k).push(r);
  }
  const unprotected = [];
  for (const r of found) {
    const k = `${r.s}.${r.t}`;
    const on = (idxByTable.get(k) ?? []).filter(
      (x) => x.cols.length === 1 && x.cols[0] === r.c && x.is_live,
    );
    const full = on.filter((x) => !x.is_partial);
    const partial = on.filter((x) => x.is_partial);
    if (full.length) {
      log(`  ENFORCED    ${k}.${r.c}   ${full.map((x) => x.idx).join(", ")}`);
    } else if (partial.length) {
      warn(`  PARTIAL     ${k}.${r.c}   ${partial.map((x) => x.idx).join(", ")}  — rows outside the predicate are unprotected`);
      unprotected.push(`${k}.${r.c} (partial only)`);
    } else {
      warn(`  NOT ENFORCED ${k}.${r.c}  — no single-column unique index; only the minter prevents a collision`);
      unprotected.push(`${k}.${r.c}`);
    }
  }
  log("");
  log(`  ${found.length - unprotected.length}/${found.length} doc-number column(s) are protected by a full unique index.`);
  if (unprotected.length) warn(`  UNPROTECTED (${unprotected.length}): ${unprotected.join(", ")}`);

  /* ═════ (C) SERIES CENSUS + GAPS ══════════════════════════════════════════ */
  log("");
  log(`=== (C) SERIES CENSUS — newest ${SERIES_MONTHS} month(s) per series ===`);
  log("    gaps BELOW the max are harmless (max+1 steps over them).");
  log("    a deletion at the TOP of a series leaves NO trace here — that is section D.");
  const seriesRows = [];
  for (const r of found) {
    const S = qi(r.s), T = qi(r.t), C = qi(r.c);
    const sel = hasCol(r.s, r.t, "created_at")
      ? await pg`SELECT ${pg(C)} AS doc_no, created_at FROM ${pg(S)}.${pg(T)} WHERE ${pg(C)} IS NOT NULL`
      : await pg`SELECT ${pg(C)} AS doc_no, NULL::timestamptz AS created_at FROM ${pg(S)}.${pg(T)} WHERE ${pg(C)} IS NOT NULL`;
    const groups = new Map();
    for (const row of sel) {
      const p = parseDocNo(row.doc_no);
      if (!p) continue;
      const key = `${p.prefix}${p.type}-${p.yymm}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...p, docNo: row.doc_no, createdAt: row.created_at });
    }
    for (const [key, arr] of groups) {
      arr.sort((a, b) => a.n - b.n);
      const max = arr[arr.length - 1];
      const present = new Set(arr.map((x) => x.n));
      const gaps = [];
      for (let i = 1; i < max.n; i += 1) if (!present.has(i)) gaps.push(i);
      seriesRows.push({
        col: `${r.s}.${r.t}.${r.c}`, key, n: arr.length, max: max.n,
        maxDocNo: max.docNo, maxCreated: max.createdAt, gaps, arr,
      });
    }
  }
  seriesRows.sort((a, b) => b.key.slice(-4).localeCompare(a.key.slice(-4)) || a.key.localeCompare(b.key));
  const months = [...new Set(seriesRows.map((s) => s.key.slice(-4)))].sort().reverse().slice(0, SERIES_MONTHS);
  for (const s of seriesRows.filter((x) => months.includes(x.key.slice(-4)))) {
    const gapTxt = s.gaps.length
      ? `  gaps=${s.gaps.length} [${s.gaps.slice(0, 20).join(",")}${s.gaps.length > 20 ? ",..." : ""}]`
      : "  gaps=0";
    log(`  ${s.key.padEnd(18)} rows=${String(s.n).padStart(5)}  max=${String(s.max).padStart(4)} (${s.maxDocNo}, created ${s.maxCreated ? new Date(s.maxCreated).toISOString() : "?"})${gapTxt}   [${s.col}]`);
  }

  /* ═════ (D) RE-ISSUE, MEASURED AGAINST THE ACCOUNT BOOK ═══════════════════ */
  log("");
  log("=== (D) NUMBERS AUTOCOUNT HOLDS vs THE ERP ROW THAT CARRIES THEM TODAY ===");
  log("    source: backend/scripts/data/ac-live-proof.json");
  let reissued = 0;
  for (const [docNo, bookDate, op] of AC_HELD) {
    const hits = [];
    for (const r of found) {
      const S = qi(r.s), T = qi(r.t), C = qi(r.c);
      const cols = sampleCols(r.s, r.t, r.c);
      const rows = await pg`
        SELECT ${pg(cols.map(qi))} FROM ${pg(S)}.${pg(T)} WHERE ${pg(C)} = ${docNo} LIMIT 5`;
      for (const x of rows) hits.push({ col: `${r.s}.${r.t}.${r.c}`, id: x.id ?? "-", ...x });
    }
    if (!hits.length) {
      log(`  ${docNo.padEnd(16)} book=${bookDate} (${op})  ERP: NO ROW — the book holds a number the ERP no longer has.`);
      continue;
    }
    for (const h of hits) {
      const created = h.created_at ? new Date(h.created_at) : null;
      const after = created && created > new Date(`${bookDate}T23:59:59Z`);
      if (after) reissued += 1;
      const verdict = after
        ? "RE-ISSUED — this ERP row was created AFTER the book received this number"
        : "consistent — ERP row predates or matches the book entry";
      const line = `  ${docNo.padEnd(16)} book=${bookDate} (${op})  ERP ${h.col} id=${h.id} created=${created ? created.toISOString() : "?"} status=${h.status ?? "-"}  => ${verdict}`;
      if (after) warn(line); else log(line);
    }
  }
  log("");
  log(`  ${reissued} of ${AC_HELD.length} known book numbers are carried by an ERP row created after the book received them.`);

  /* ═════ (E) OUTBOX MEMORY ═════════════════════════════════════════════════ */
  log("");
  log("=== (E) WHAT scm.autocount_outbox STILL REMEMBERS ABOUT THOSE NUMBERS ===");
  const obExists = await pg`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'scm' AND table_name = 'autocount_outbox' LIMIT 1`;
  if (!obExists.length) {
    warn("  scm.autocount_outbox is not present in this database.");
  } else {
    const nums = AC_HELD.map(([d]) => d);
    const ob = await pg`
      SELECT id, doc_type, doc_no, op, status, attempts, created_at, updated_at
        FROM scm.autocount_outbox
       WHERE doc_no = ANY(${nums})
       ORDER BY doc_no, created_at`;
    if (!ob.length) {
      warn(`  NO outbox row for any of the ${nums.length} numbers the book holds.`);
      warn("  The queue is the ERP's only record of what it has exported, and it is on");
      warn("  golive-wipe-hc.mjs's CLEAR list — so a wipe erases that memory with the documents.");
    } else {
      for (const r of ob) {
        log(`  ${String(r.doc_no).padEnd(16)} op=${r.op} status=${r.status} attempts=${r.attempts} created=${new Date(r.created_at).toISOString()}`);
      }
    }
    const [{ n: obTotal }] = await pg`SELECT count(*)::int AS n FROM scm.autocount_outbox`;
    const [{ n: obOldest }] = await pg`
      SELECT count(*)::int AS n FROM scm.autocount_outbox WHERE created_at < '2026-08-20T00:00:00Z'`;
    log(`  outbox total rows=${obTotal}; rows created before 2026-08-20=${obOldest}`);
  }

  /* ═════ (E2) EVERY OUTBOX ROW ══════════════════════════════════════
     (E) asks only about the numbers ac-live-proof.json names. This lists the
     whole queue, because the ERP's export memory is now small enough to print
     and the interesting rows are the ones NOBODY thought to ask about — a
     `pending` row carrying a number the book may already hold is a refusal
     that has not happened yet. */
  if (obExists.length) {
    log("");
    log("=== (E2) EVERY scm.autocount_outbox ROW ===");
    const all = await pg`
      SELECT doc_type, doc_no, op, status, attempts, ac_doc_no, created_at, sent_at
        FROM scm.autocount_outbox ORDER BY created_at`;
    log(`  ${all.length} row(s).`);
    for (const r of all) {
      console.log(`    ${new Date(r.created_at).toISOString()}  ${String(r.doc_type).padEnd(3)} ${String(r.doc_no).padEnd(18)} op=${String(r.op).padEnd(10)} status=${String(r.status).padEnd(8)} attempts=${r.attempts} ac_doc_no=${r.ac_doc_no ?? "-"}`);
    }
  }

  /* ═════ (F) CREATED-AT INVERSIONS ═════════════════════════════════════════ */
  log("");
  log("=== (F) CREATED-AT INVERSIONS (a lower suffix created later than a higher one) ===");
  let inversions = 0;
  for (const s of seriesRows) {
    const dated = s.arr.filter((x) => x.createdAt);
    if (dated.length < 2) continue;
    const byN = [...dated].sort((a, b) => a.n - b.n);
    for (let i = 1; i < byN.length; i += 1) {
      const prev = byN[i - 1], cur = byN[i];
      if (new Date(prev.createdAt) > new Date(cur.createdAt)) {
        inversions += 1;
        if (inversions <= 40) {
          warn(`  ${s.col}  ${prev.docNo} (${new Date(prev.createdAt).toISOString()}) created AFTER ${cur.docNo} (${new Date(cur.createdAt).toISOString()})`);
        }
      }
    }
  }
  log(inversions === 0
    ? "  NONE — every series' creation order matches its numbering order."
    : `  ${inversions} inversion(s). Not proof on its own — a backfill or a restore reorders created_at too.`);

  /* ═════ (G) COUNTER SEED PREVIEW ══════════════════════════════════
     What scm.doc_number_counters holds today, and what the seed migration
     WOULD write — computed here, on production, BEFORE the migration is
     written, so the seed is measured rather than assumed.

     Three inputs per series, and the seed is the highest of them + 1:
       liveMax    highest surviving suffix in the minter-owned column. This is
                  today's whole counter, and it is the one a delete lowers.
       outboxMax  highest suffix scm.autocount_outbox has ever carried for the
                  series — numbers the ERP has at least ATTEMPTED to export.
                  Post-wipe this remembers nothing before 2026-08-20, which is
                  the point of section E.
       bookMax    highest suffix the AED_HOUZS book is KNOWN to hold, from
                  ac-live-proof.json. The ONLY input the ERP cannot re-derive,
                  and therefore the only one the migration has to hardcode.

     A series whose seed is above liveMax+1 is one where the counter is being
     RAISED past the account book. Those are listed separately: they are the
     entire risk surface of the seed. */
  log("");
  log("=== (G) COUNTER SEED PREVIEW — scm.doc_number_counters ===");
  const countersExists = await pg`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'scm' AND table_name = 'doc_number_counters' LIMIT 1`;
  if (!countersExists.length) {
    log("  scm.doc_number_counters: ABSENT — the counter table has not shipped yet.");
    log("  That is the FINDING, not an error: today the surviving rows ARE the counter.");
  } else {
    const cnt = await pg`SELECT series, next_n, seed_source FROM scm.doc_number_counters ORDER BY series`;
    log(`  scm.doc_number_counters: PRESENT, ${cnt.length} row(s).`);
    for (const r of cnt) console.log(`    ${String(r.series).padEnd(20)} next_n=${String(r.next_n).padStart(5)}  ${r.seed_source ?? ""}`);
  }

  // liveMax per series, restricted to the columns a MINTER owns. A reference
  // column (an SO line naming its parent) must never feed a counter.
  const seedMap = new Map();
  const bump = (head, field, n, note) => {
    if (!seedMap.has(head)) seedMap.set(head, { live: 0, outbox: 0, book: 0, liveCol: "", bookNote: "" });
    const e = seedMap.get(head);
    if (n > e[field]) {
      e[field] = n;
      if (field === "live") e.liveCol = note;
      if (field === "book") e.bookNote = note;
    }
  };
  for (const s of seriesRows) {
    if (!REG.has(s.col)) continue;
    bump(s.key, "live", s.max, s.col);
  }
  if (obExists.length) {
    const obAll = await pg`SELECT doc_no FROM scm.autocount_outbox WHERE doc_no IS NOT NULL`;
    for (const r of obAll) {
      const p = parseDocNo(r.doc_no);
      if (p) bump(`${p.prefix}${p.type}-${p.yymm}`, "outbox", p.n, "outbox");
    }
  }
  for (const [docNo, bookDate, op] of AC_HELD) {
    const p = parseDocNo(docNo);
    if (p) bump(`${p.prefix}${p.type}-${p.yymm}`, "book", p.n, `${op} ${bookDate}`);
  }

  const seeds = [...seedMap.entries()]
    .map(([head, e]) => ({
      head,
      ...e,
      max: Math.max(e.live, e.outbox, e.book),
    }))
    .sort((a, b) => a.head.localeCompare(b.head));
  const raised = seeds.filter((s) => s.max > s.live);
  log("");
  log(`  ${seeds.length} series would be seeded. ${raised.length} of them sit ABOVE the surviving ERP rows.`);
  log("");
  log("  head                 liveMax  outboxMax  bookMax  ->  next_n   source of the ceiling");
  for (const s of seeds) {
    const src = s.max === s.book && s.book > 0 && s.book >= s.live && s.book >= s.outbox
      ? `AutoCount book (${s.bookNote})`
      : s.max === s.outbox && s.outbox > s.live
        ? "scm.autocount_outbox"
        : `live rows (${s.liveCol})`;
    const line = `    ${s.head.padEnd(20)} ${String(s.live).padStart(7)} ${String(s.outbox).padStart(10)} ${String(s.book).padStart(8)}  ->  ${String(s.max + 1).padStart(6)}   ${src}`;
    if (s.max > s.live) warn(line.trim()); else console.log(line);
  }
  if (raised.length) {
    log("");
    log("  RAISED PAST THE SURVIVING ROWS — the whole risk surface of the seed:");
    for (const s of raised) {
      log(`    ${s.head}: live max ${s.live} -> next number ${s.max + 1} (book ${s.book}, outbox ${s.outbox})`);
    }
  }
  // Which minter-owned series exist in the DB but have NO book evidence at all.
  const noBook = seeds.filter((s) => s.book === 0 && s.head.startsWith("HC-"));
  if (noBook.length) {
    log("");
    log(`  HC series with NO book evidence (seeded from ERP rows alone): ${noBook.map((s) => s.head).join(", ")}`);
  }

  /* ═════ VERDICT ═══════════════════════════════════════════════════════════
     The discovery in this script is deliberately WIDE — it matches on column
     NAME, so it picks up reference columns as well as identity ones. A SO line
     and a status-change row both carry `doc_no`, and both SHOULD repeat it:
     that is the parent they belong to, not a number they own. Counting those as
     "duplicate documents" would answer the owner's question wrongly and loudly.

     So the verdict splits them. A column is IDENTITY if a minter is known to
     write it (REG) or the database enforces it unique — either is a statement
     that the value names one document. Everything else is a REFERENCE column
     and its repeats are the schema working. */
  log("");
  log("=== VERDICT ===");
  const identity = found.filter((r) => {
    const k = `${r.s}.${r.t}.${r.c}`;
    return REG.has(k) || !unprotected.some((u) => u.startsWith(k));
  });
  const identityDirty = identity
    .map((r) => `${r.s}.${r.t}.${r.c}`)
    .filter((k) => dirty.has(k));
  const referenceDirty = [...dirty.keys()].filter((k) => !identityDirty.includes(k));

  log(`  ${identity.length} IDENTITY doc-number column(s) (a minter owns it, or the DB enforces it unique).`);
  if (identityDirty.length === 0) {
    log("  Q1 ANSWER: NO. No two ERP documents share a document number.");
    log("             Zero duplicates on any identity column.");
  } else {
    warn(`  Q1 ANSWER: YES — ${identityDirty.length} IDENTITY column(s) hold a repeated number:`);
    for (const k of identityDirty) warn(`             ${k}  (${dirty.get(k)} number(s)) — SEE SECTION A`);
  }
  const regUnprotected = [...REG.keys()].filter(
    (k) => discovered.has(k) && unprotected.some((u) => u.startsWith(k)),
  );
  log(regUnprotected.length === 0
    ? "  Every column a minter owns is backed by a full unique index, so a collision cannot commit."
    : `  ${regUnprotected.length} minter-owned column(s) have NO full unique index: ${regUnprotected.join(", ")}`);
  if (referenceDirty.length) {
    log("");
    log(`  ${referenceDirty.length} REFERENCE column(s) repeat a number, which is what they are for`);
    log("  (lines, audit rows and queue rows all name their parent document):");
    for (const k of referenceDirty) log(`             ${k}  (${dirty.get(k)} number(s))`);
  }
  log("");
  log(`  ${reissued} known AutoCount number(s) are carried by a NEWER ERP row (section D).`);
} catch (err) {
  console.error(`check-doc-no-reissue FAILED to read the database: ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
process.exit(exitCode);
