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
// ItemCode, Qty, UnitPrice and Desc2. Those are the four an /edit actually
// writes. A `Retire: true` line is counted separately — it is a deletion, not a
// value change, and lumping it in with the value diffs would overstate both.
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

/** dtlKey -> { itemKey, qty, unitPrice, docNo }, and dtlKey -> desc2. */
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
          if (bh && !txtEq(String(body.Header[k]).slice(0, 10), bh.docDate)) {
            diffs.push({ doc: r.doc_no, bookDoc, dtlKey: "(header)", field: "DocDate",
              sent: body.Header[k], book: bh.docDate, sentAt: r.sent_at, by: r.created_by });
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
