#!/usr/bin/env node
// DID THE WRITE-BACK CHANGE THE ACCOUNT BOOK TO ANYTHING IT DID NOT ALREADY SAY?
//
// The owner's question, 2026-09-09, on learning that two days of cutover
// repairs had queued write-backs and that hundreds had already been sent:
//
//   「如果是这样我怎么知道我的数据对不对」
//
// This answers it with evidence, per document, and WITHOUT touching the live
// account book.
//
// ── WHY NO LIVE READ, WHICH LOOKS LIKE THE OBVIOUS WAY TO DO IT ─────────────
//
// Two reasons, and the second is the load-bearing one.
//
// 1. A wide read of AED_HOUZS starves the write-back itself: SalesOrder.
//    InternalSave times out, and the 500 that comes back looks exactly like a
//    permissions refusal while really being a LOCK TIMEOUT. Measured before.
//
// 2. The live book cannot answer the question anyway. It holds TODAY's value.
//    Finding our value there tells you nothing, because "the book already said
//    this and we echoed it" and "we overwrote it with this" both end with the
//    book holding our value. What separates them is what the book held BEFORE
//    the write — and that is exactly what the committed snapshot is.
//
// So the comparison is: what we SENT (scm.autocount_outbox.payload, which the
// table's own contract calls a snapshot "taken at enqueue time, never
// recomposed at drain") against what the book HELD at
// backend/scripts/data/ac-reconcile-truth.json.gz, exported
// 2026-09-09T00:18:49.235Z from AED_HOUZS live.
//
// ── THE ONE DISTINCTION THAT DECIDES EVERY ROW ─────────────────────────────
//
// The snapshot has a timestamp, so a sent row falls on one side of it:
//
//   sent BEFORE the export  — the snapshot ALREADY CONTAINS our write. A match
//                             here proves nothing at all and is reported as
//                             UNDECIDABLE, never as "harmless". Calling it
//                             harmless is the trap this whole file exists to
//                             avoid: it is the check that answers a different
//                             question.
//   sent AFTER  the export  — the snapshot is the BEFORE picture. Now a match
//                             means we echoed what the book already held
//                             (harmless), and a difference means our repair
//                             changed his source of truth (named, with both
//                             values).
//
// ── WHAT IS COMPARED ───────────────────────────────────────────────────────
//
// Per line, keyed by AutoCount DtlKey, which is the identity both sides carry:
// ItemCode, Qty, UnitPrice and Desc2. A `Retire: true` line is counted
// separately — it is a deletion, not a value change, and lumping it in with the
// value diffs would overstate both.
//
// WHAT A KEYED EDIT ACTUALLY SENDS, read out of composeEdit (autocount-
// writeback.ts:1436) rather than assumed, because it decides how to read this
// report:
//
//   ItemCode     STRIPPED on a normal edit — `const { ItemCode: acItemCode,
//                ...rest } = d` — and put back only on a REBUILD. Owner
//                2026-08-13: an edit changes a line's Description 2, never its
//                SKU. So ItemCode is `undefined` on nearly every row here and
//                is SKIPPED, not counted as a match. A comparison that scored
//                it as "identical" would inflate the harmless column with
//                fields we never sent.
//   Qty          SENT.
//   UnitPrice    SENT.
//   Desc2        SENT — and this is the one that matters. Desc2 is where a
//                sofa's build text lives, which is the single thing the owner
//                carved out of 「一律跟账本」 with 「除了sofa compartment而已啊」.
//
// So these edits are NOT no-ops by construction: they rewrite quantity, price
// and specification on lines the account book already holds. Whether that
// rewrote anything is the whole question below.
//
// Header comparison is DELIBERATELY LIMITED to DocDate. The other header keys
// an edit sends (addresses, agent, UDFs) have no counterpart in the snapshot's
// eight header fields, and inventing a mapping to make the report look complete
// is how a wrong answer gets a confident tone. They are counted as
// NOT-COMPARABLE and named, not silently dropped.
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer — the answer IS the output.
//
// RE-RUN: inert. It writes nothing.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const HERE = dirname(fileURLToPath(import.meta.url));

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch { return undefined; }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const COMPANY = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : 1;
const TOP = Number(process.env.TOP || 80);

// ── the book, as it stood at the export ────────────────────────────────────
const snapPath = process.env.SNAPSHOT || resolve(HERE, "data/ac-reconcile-truth.json.gz");
const snap = JSON.parse(gunzipSync(readFileSync(snapPath)).toString("utf8"));
const SNAP_AT = new Date(snap.exported_at);

/* The snapshot stores rows POSITIONALLY against its own field lists, so the
   indexes are read from the file rather than hard-coded — a column added to the
   exporter must not silently shift what this compares. */
const hIdx = Object.fromEntries(snap.header_fields.map((f, i) => [f, i]));
const lIdx = Object.fromEntries(snap.line_fields.map((f, i) => [f, i]));
const dIdx = Object.fromEntries(snap.desc2_fields.map((f, i) => [f, i]));

/* KEYED BY DtlKey ALONE, across all six document types, which is only safe if
   DtlKey is globally unique. MEASURED on this snapshot rather than assumed:
   62769 + 18890 + 21746 + 48822 + 45950 + 22633 = 220,810 line rows in, and the
   map ends with exactly 220,810 entries — zero collisions. If a future export
   ever collides, the assertion below fails loudly instead of silently comparing
   a sales-order line against a purchase-order one. */
const bookLine = new Map();
const bookDesc2 = new Map();
const bookHeader = new Map();
for (const t of Object.keys(snap.types)) {
  for (const r of snap.types[t].headers) {
    bookHeader.set(`${t}|${r[hIdx.docNo]}`, {
      docDate: r[hIdx.docDate], cancelled: r[hIdx.cancelled], docTotal: r[hIdx.docTotal],
    });
  }
  for (const r of snap.types[t].lines) {
    bookLine.set(String(r[lIdx.dtlKey]), {
      type: t, docNo: r[lIdx.docNo], itemKey: r[lIdx.itemKey],
      qty: r[lIdx.qty], unitPrice: r[lIdx.unitPrice],
    });
  }
  for (const r of snap.types[t].desc2) bookDesc2.set(String(r[dIdx.dtlKey]), r[dIdx.desc2]);
}
{
  const rows = Object.keys(snap.types).reduce((n, t) => n + snap.types[t].lines.length, 0);
  if (bookLine.size !== rows) {
    console.error(
      `DtlKey is NOT unique in this snapshot: ${rows} line rows collapsed to ${bookLine.size} keys. `
      + 'Comparing by DtlKey alone would match a line of one document against a line of another. '
      + 'Refusing to report rather than report something wrong.',
    );
    process.exit(1);
  }
}

/* Money and quantity come off two systems as differently-formatted strings
   ("4000.0000" vs 4000). Compared as NUMBERS, so formatting is never reported
   as a change to the account book — and NaN never compares equal, so an
   unparseable value falls through to the string test rather than passing. */
const numEq = (a, b) => {
  const x = Number(a), y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 0.005;
  return String(a ?? "") === String(b ?? "");
};
/* Desc2: the book stores blank as ABSENT (the exporter omits it), so absent and
   "" are the same statement about the document and must not read as a change. */
const txtEq = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
/** YYYY-MM-DD out of whatever a date arrived as; null if it is not a date. */
const isoDay = (v) => {
  if (v == null) return null;
  const t = String(v);
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const say = (s = "") => console.log(s);

try {
  const rows = await pg`
    SELECT id, op, doc_type, doc_no, payload, sent_at, created_at, created_by, ac_doc_no
    FROM scm.autocount_outbox
    WHERE status = 'sent' AND company_id = ${COMPANY}
    ORDER BY sent_at NULLS LAST`;

  say(`Snapshot  ${snapPath}`);
  say(`exported  ${snap.exported_at}   source: ${snap.source}`);
  say(`sent rows ${rows.length} (company ${COMPANY})`);
  say();

  const before = [], after = [], noTime = [];
  for (const r of rows) {
    if (!r.sent_at) noTime.push(r);
    else if (new Date(r.sent_at) < SNAP_AT) before.push(r);
    else after.push(r);
  }
  say("=== WHICH SIDE OF THE SNAPSHOT ===");
  say(`  sent BEFORE the export : ${before.length}  -> the snapshot already contains these; UNDECIDABLE from it`);
  say(`  sent AFTER  the export : ${after.length}  -> the snapshot is the BEFORE picture; these are decidable`);
  say(`  no sent_at recorded    : ${noTime.length}`);
  say();

  /* ── WHAT SHAPE ARE THESE PAYLOADS, ACTUALLY? ─────────────────────────────
     Printed before the comparison, and deliberately not skipped when the
     comparison succeeds. This script maps payload keys onto snapshot columns
     from READING composeEdit; if that mapping is wrong, every count below is
     wrong in a way that still looks like a clean report — zero differences
     reads as "nothing was overwritten" whether it is true or whether we simply
     compared nothing. This census is what tells those two apart, and it costs
     one pass over rows already in memory. */
  const shape = new Map();
  for (const r of rows) {
    const b = r.payload?.body ?? {};
    const arr = Array.isArray(b.Lines) ? "Lines" : Array.isArray(b.Details) ? "Details" : "none";
    const n = arr === "none" ? 0 : b[arr].length;
    const first = n ? Object.keys(b[arr][0]).sort().join("+") : "(no lines)";
    const k = `${r.op} | ${arr} | ${first}`;
    const cur = shape.get(k) ?? { rows: 0, lines: 0 };
    cur.rows++; cur.lines += n; shape.set(k, cur);
  }
  say("=== PAYLOAD SHAPES AMONG THE SENT ROWS ===");
  say("  op | line array | keys on the first line          rows / lines");
  for (const [k, v] of [...shape.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    say(`  ${k}   ${v.rows} / ${v.lines}`);
  }
  say();

  const diffs = [], matches = [], missing = [], retires = [];
  let linesCompared = 0, headerNotComparable = 0;

  for (const r of after) {
    const body = r.payload?.body ?? {};
    const bookDoc = body.DocNo ?? r.ac_doc_no ?? null;
    const lines = Array.isArray(body.Lines) ? body.Lines
      : Array.isArray(body.Details) ? body.Details : [];

    // header: only DocDate has a counterpart in the snapshot's eight fields
    const bh = bookDoc ? bookHeader.get(`${r.doc_type}|${bookDoc}`) : null;
    if (body.Header) {
      for (const k of Object.keys(body.Header)) {
        if (k === "DocDate") {
          /* COMPARED AS A DATE, NOT AS TEXT — this was wrong in the first run
             and it mattered. The payload carries what the composer's Date
             serialised to ("Tue Jun 17 2025 00:00:00 GMT+0000") while the book
             exports "2025-06-17". Slicing ten characters off the first gives
             "Tue Jun 17", which never equals the second, so EVERY DocDate was
             reported as a change to the account book when it is the same day.
             A formatting difference is not a fact about his data. */
          const sentDay = isoDay(body.Header[k]);
          if (bh && sentDay && !txtEq(sentDay, bh.docDate)) {
            diffs.push({ doc: r.doc_no, bookDoc, dtlKey: "(header)", field: "DocDate",
              sent: sentDay, book: bh.docDate, sentAt: r.sent_at, by: r.created_by });
          }
        } else headerNotComparable++;
      }
    }

    for (const ln of lines) {
      if (ln?.Retire === true) { retires.push({ doc: r.doc_no, bookDoc, dtlKey: ln.DtlKey ?? null }); continue; }
      const key = ln?.DtlKey == null ? null : String(ln.DtlKey);
      if (!key) continue;                       // a keyless line is refused upstream
      const bl = bookLine.get(key);
      if (!bl) { missing.push({ doc: r.doc_no, bookDoc, dtlKey: key }); continue; }

      const checks = [
        ["ItemCode", ln.ItemCode, bl.itemKey, txtEq],
        ["Qty", ln.Qty, bl.qty, numEq],
        ["UnitPrice", ln.UnitPrice, bl.unitPrice, numEq],
        ["Desc2", ln.Desc2, bookDesc2.get(key), txtEq],
      ];
      for (const [field, sent, book, eq] of checks) {
        if (sent === undefined) continue;       // key not sent = book keeps its own
        linesCompared++;
        if (eq(sent, book)) matches.push({ doc: r.doc_no, dtlKey: key, field });
        else diffs.push({ doc: r.doc_no, bookDoc, dtlKey: key, field,
          sent, book, sentAt: r.sent_at, by: r.created_by });
      }
    }
  }

  say("=== THE ANSWER, over the rows sent AFTER the snapshot ===");
  say(`  field values compared            : ${linesCompared}`);
  say(`  IDENTICAL to what the book held  : ${matches.length}   (harmless — we echoed his own value back)`);
  say(`  DIFFERENT from what the book held: ${diffs.length}   ${diffs.length ? "<-- these CHANGED his source of truth" : ""}`);
  say(`  line retired (a deletion, not a value change): ${retires.length}`);
  say(`  DtlKey not in the snapshot at all: ${missing.length}   (line created after the export, or never in the book)`);
  say(`  header keys with no snapshot counterpart, not compared: ${headerNotComparable}`);
  say();

  /* ── THE CLASSIFICATION THAT ANSWERS THE OWNER'S QUESTION ─────────────────
     "Different from the book" is not the same as "we damaged your book", and
     reporting one number for both would be the wrong answer in the alarming
     direction. Two splits decide it, and both come from columns, not judgement:

       WHO   created_by. A named user means a PERSON did this in the ERP. For a
             document a person raised or edited, the ERP is MASTER and pushing
             the value out is the write-back working — that is the whole reason
             it is switched on. created_by NULL is the unattributed population
             the repair bursts sit in.
       WHAT  whether the account book already had the document. An ERP-created
             document (the outbox doc_no and the book DocNo are the same string,
             e.g. HC-PO-2609-001) was ours to write. A MIGRATED one (the book
             calls it SO-0xxxxx while the ERP calls it HC-SO-0xxxxx) existed in
             his book before the ERP ever saw it, and changing THAT is what
             「你不可以有记录再这边啊」 is about.

     The dangerous cell is UNATTRIBUTED x MIGRATED. */
  const cell = (d) => `${d.by == null ? "unattributed" : "person " + d.by}  |  `
    + `${d.doc === d.bookDoc ? "ERP-created" : "MIGRATED (book had it)"}`;
  const byCell = new Map();
  for (const d of diffs) {
    const k = cell(d);
    const c = byCell.get(k) ?? { n: 0, docs: new Set(), fields: new Set() };
    c.n++; c.docs.add(d.doc); c.fields.add(d.field); byCell.set(k, c);
  }
  say("=== THE DIFFERENCES, SPLIT BY WHO AND BY WHOSE DOCUMENT ===");
  for (const [k, c] of [...byCell.entries()].sort((a, b) => b[1].n - a[1].n)) {
    say(`  ${k}  —  ${c.n} value(s) over ${c.docs.size} document(s): ${[...c.fields].sort().join(", ")}`);
  }
  const dangerous = diffs.filter((d) => d.by == null && d.doc !== d.bookDoc);
  say();
  say(`  UNATTRIBUTED changes to a document the book ALREADY HAD: ${dangerous.length}`);
  if (!dangerous.length) {
    say("  -> Nothing our repairs did reached a document the account book already held.");
  } else {
    say("  -> THESE are the ones to look at. Every one is listed below.");
    for (const d of dangerous) {
      say(`     ${d.doc} book=${d.bookDoc} DtlKey=${d.dtlKey} ${d.field}: book=${JSON.stringify(d.book)} sent=${JSON.stringify(d.sent)}`);
    }
  }
  say();

  if (diffs.length) {
    say(`=== EVERY DIFFERENCE (showing up to ${TOP}) ===`);
    for (const d of diffs.slice(0, TOP)) {
      say(`  ${d.doc}  book=${d.bookDoc}  DtlKey=${d.dtlKey}  ${d.field}`);
      say(`      the book held : ${JSON.stringify(d.book)}`);
      say(`      we sent       : ${JSON.stringify(d.sent)}`);
      say(`      sent_at=${d.sentAt?.toISOString?.() ?? d.sentAt}  created_by=${d.by ?? "NULL"}`);
    }
    if (diffs.length > TOP) say(`  ... and ${diffs.length - TOP} more`);
  } else {
    say("NO DIFFERENCE FOUND. Every value the write-back sent after the snapshot");
    say("was the value the account book already held.");
  }
  say();

  if (missing.length) {
    say(`=== DtlKeys NOT IN THE SNAPSHOT (showing up to ${TOP}) ===`);
    say("  Not necessarily wrong: a line the ERP created after 00:18 would look");
    say("  exactly like this. Named rather than counted so it can be checked.");
    for (const m of missing.slice(0, TOP)) say(`  ${m.doc}  book=${m.bookDoc}  DtlKey=${m.dtlKey}`);
    if (missing.length > TOP) say(`  ... and ${missing.length - TOP} more`);
  }
} catch (e) {
  console.error("Database unreachable or query failed:", e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
