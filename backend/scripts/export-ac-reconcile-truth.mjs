#!/usr/bin/env node
/* export-ac-reconcile-truth — the AutoCount side of check-ac-erp-reconcile.mjs.
 *
 * READ-ONLY against the live AED_HOUZS book (SELECT only; staff keep working
 * in AutoCount while this runs).  It writes ONE file,
 * data/ac-reconcile-truth.json.gz, holding EVERY header and EVERY line of all
 * six document types — SO PO GR DO IV PI.  Nothing is filtered here on
 * purpose: the population rules (which documents the migration was ever meant
 * to carry) are applied in the CHECKER, from the raw columns exported here, so
 * a rule change does not need a fresh trip to the book.
 *
 * WHY sqlcmd AND NOT pyodbc.  The other exporters in this directory are Python
 * (export-ac-reimport.py and friends).  This one is Node because the checker
 * is Node and the workflow already installs Node — and because the office host
 * has no Python at all (memory note office-host-access-facts, 2026-09-05).
 *
 * TRANSPORT.  sqlcmd over ZeroTier.  Each SELECT emits ONE column: the fields
 * joined by CHAR(31) (unit separator), because a delimiter that can appear in
 * an AutoCount Description is a parser waiting to lie.  CR/LF, TAB and CHAR(31)
 * inside a description are replaced with a space before the join for the same
 * reason.  -W trims sqlcmd's column padding; -y is NOT passed (sqlcmd refuses
 * -W and -y together) and the longest SODTL Description measured 2026-09-07
 * was 86 chars, inside sqlcmd's 256-char default width for a varchar
 * expression.
 *
 * DESC2 — added 2026-09-07 for the VARIANT reconcile.  The owner asked for the
 * variants inside each line ("还有里面的variant 啊 col divan gap 等等"), and the
 * only place AutoCount records them is the line's own build text.  It is
 * `<DTL>.Desc2`, nvarchar(100) on all six detail tables (checked against
 * INFORMATION_SCHEMA on the live book, 2026-09-07) — NOT `Description2`, which
 * does not exist, and emphatically NOT `FurtherDescription`, the nvarchar(max)
 * RTF column that carries the PICTURE.  An unbounded scan of that picture
 * column is what made SalesOrder.InternalSave() fail with
 * "The wait operation timed out" earlier the same day, so this column is never
 * read here.
 *
 * Desc2 is pulled in BOUNDED KEY WINDOWS — `DtlKey > lo AND DtlKey <= hi`,
 * ordered by DtlKey, with a pause between windows and a 15-second statement
 * timeout — rather than in the one-shot scan the other projections use.  Three
 * other agents were reading this book while this was written; a diagnostic must
 * not be what starves the write-back.  Measured 2026-09-07: a 40,000-key window
 * over SODTL answered in 1.6s.
 *
 * Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB   (default AED_HOUZS)
 *       AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
 *       SQLCMD  (default the SQL Server 110 client path)
 *       OUT_DIR (default: this script's data/)
 *       AC_DESC2_WINDOW   (default 40000 DtlKeys per batch)
 *       AC_DESC2_PAUSE_MS (default 200ms between batches)
 *       AC_STMT_TIMEOUT_S (default 180s on the bulk projections; the Desc2
 *                          windows are always capped at 15s)
 *
 * Usage:  AC_CRED_FILE=<path> node backend/scripts/export-ac-reconcile-truth.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || path.join(here, "data");
const HOST = process.env.AC_HOST || "10.147.17.100,55500";
const DB = process.env.AC_DB || "AED_HOUZS";
const USER = process.env.AC_USER || "sa2";
const SQLCMD =
  process.env.SQLCMD ||
  "C:\\Program Files\\Microsoft SQL Server\\110\\Tools\\Binn\\sqlcmd.exe";
const CRED = process.env.AC_CRED_FILE;
if (!CRED || !fs.existsSync(CRED)) {
  console.error("AC_CRED_FILE must point at a file holding only the DB password");
  process.exit(2);
}
/* Read once, passed as an argv value, never logged and never written out. */
const PWD = fs.readFileSync(CRED, "utf8").trim();

const US = "\u001f";

const DESC2_WINDOW = Number(process.env.AC_DESC2_WINDOW || 40000);
const DESC2_PAUSE_MS = Number(process.env.AC_DESC2_PAUSE_MS || 200);
const DESC2_TIMEOUT_S = 15; // the hard constraint on the live book, not a tuneable
const DESC2_MIN_WINDOW = 2500; // narrower than this and a timeout is not about window size
const BULK_TIMEOUT_S = Number(process.env.AC_STMT_TIMEOUT_S || 180);

/* Transport failures that are worth asking again about, as opposed to a bad
   query or a wrong password.  All three were seen against this book on
   2026-09-07 while three other agents were reading it: the statement timeout
   the 15-second cap produces, and the two shapes a dropped ZeroTier tunnel
   takes.  Matched on sqlcmd's own words rather than on an exit code, because
   sqlcmd exits 1 for everything. */
/* sqlcmd is a Windows program, so its output is CRLF; a runner reading it on
   Linux is not. Built from char codes so the escape survives every editor and
   patch tool this file passes through - it did not, twice, on 2026-09-07. */
const NEWLINE = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));

const TRANSIENT = /Timeout expired|Communication link failure|forcibly closed|transport-level error|Login timeout expired/i;

/* Anything that might carry the password out of this process goes through here
   first. PWD is checked for emptiness because String.replaceAll("") inserts the
   replacement between every character. */
const scrub = (text) => (PWD ? String(text).split(PWD).join("<redacted>") : String(text));

/* A synchronous pause, because every read here is execFileSync and turning the
   whole exporter async just to sleep would be a bigger change than the sleep. */
const pause = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/* Runs one SELECT and returns rows already split on the unit separator.  The
   query goes through a temp -i file: a long statement on a Windows command
   line is a quoting minefield, and -Q would put it there.

   `timeoutSec` becomes sqlcmd's -t, so a statement that runs away is KILLED
   rather than left holding a scan on the production book while the write-back
   waits behind it. */
/* One attempt.  `rows` below is what everything calls; it retries this. */
function rowsOnce(sql, expectFields, timeoutSec) {
  const f = path.join(
    os.tmpdir(),
    `ac-recon-${process.pid}-${Math.random().toString(36).slice(2)}.sql`,
  );
  fs.writeFileSync(f, `SET NOCOUNT ON;\n${sql}\n`, "utf8");
  let out;
  try {
    out = execFileSync(
      SQLCMD,
      ["-S", HOST, "-d", DB, "-U", USER, "-P", PWD, "-h", "-1", "-W", "-w", "65535",
       "-b", "-l", "15", "-t", String(timeoutSec), "-i", f],
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
    );
  } catch (e) {
    /* THE PASSWORD IS IN THE ARGV, AND NODE PUTS THE ARGV IN THE ERROR.
       execFileSync builds its message as "Command failed: <the whole command
       line>", so ANY non-zero sqlcmd exit — a timeout, a dropped tunnel — used
       to print `-P <password>` into whatever is reading stdout: a terminal, a
       CI log, a pasted traceback. Observed 2026-09-07 when a Desc2 window hit
       the 15-second cap. Scrub before rethrowing; the repo's own rule is that a
       credential is never read out. */
    /* The excerpt is CAPPED: sqlcmd writes the rows it managed to send to
       stdout before it died, and pasting thousands of them into an error buries
       the one line that says what went wrong. */
    const said = e.stdout ? scrub(String(e.stdout)).trim().split(NEWLINE).slice(-3).join(" / ").slice(0, 300) : "";
    const err = new Error(scrub(e.message || String(e)) + (said ? ` | sqlcmd last said: ${said}` : ""));
    err.transient = TRANSIENT.test(said) || TRANSIENT.test(String(e.message || ""));
    throw err;
  } finally {
    fs.unlinkSync(f);
  }
  const parsed = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const parts = line.split(US);
    /* A row that does not carry the expected field count means the transport
       mangled it (a stray newline, a truncated column).  Refuse — a checker
       fed a silently short row would report a false mismatch. */
    if (parts.length !== expectFields) {
      throw new Error(
        `malformed row (${parts.length} fields, expected ${expectFields}): ${line.slice(0, 160)}`,
      );
    }
    parsed.push(parts);
  }
  return parsed;
}

/* A read of this book is a SELECT over ZeroTier against a production account
   book that staff and other jobs are using.  A dropped tunnel or a statement
   the busy server would not finish is not a defect in the query, so ask again —
   three times, waiting longer each time, and never by relaxing the timeout.
   Anything else (a syntax error, a wrong column, a bad login) throws on the
   first attempt, which is what you want: retrying those just delays the truth. */
function rows(sql, expectFields, timeoutSec = BULK_TIMEOUT_S) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return rowsOnce(sql, expectFields, timeoutSec);
    } catch (e) {
      if (!e.transient) throw e;
      last = e;
      if (attempt < 3) {
        console.log(`  transport hiccup (attempt ${attempt}/3), waiting ${attempt * 5}s: ${e.message.slice(0, 120)}`);
        pause(attempt * 5000);
      }
    }
  }
  throw last;
}

/* Header projection, identical for all six types.
 *
 * CURRENCY TRAVELS WITH THE MONEY, since 2026-09-07, and `netTotal` is no longer
 * the only amount.  It used to be `ISNULL(h.LocalNetTotal, h.NetTotal)` alone —
 * the LOCAL-currency (MYR) figure — while the ERP holds the DOCUMENT-currency
 * one (`import-ac-outstanding-po.mjs:401` hard-codes 'MYR' into
 * `purchase_orders.currency` whatever the book says).  On a MYR document the two
 * are the same number and nothing showed; on `PO-009335`, which is in CNY at
 * 0.619380, the difference IS the exchange rate, and the PO line-discount repair
 * read it as a 38.06% discount and took RM 13,068.55 off a live purchase order.
 * Ledger: docs/bugs/0665-*.md.
 *
 * So both amounts now travel, beside the currency and the rate that relate them,
 * and a consumer states which one it means.  Neither is "the" total: `netTotal`
 * is the MYR figure the books are kept in, `docTotal` is what the document
 * itself says, and comparing an ERP figure against the wrong one is the defect
 * this fixes.  The book holds 22 CNY purchase orders out of 9,412 and all 13,366
 * sales orders in MYR, so on today's data every other document has
 * netTotal === docTotal — which is exactly why nobody could see the bug. */
const headerSql = (h, d) => `
SELECT LTRIM(RTRIM(ISNULL(h.DocNo,''))) + CHAR(31) +
       ISNULL(CONVERT(varchar(10), h.DocDate, 23),'') + CHAR(31) +
       ISNULL(h.Cancelled,'F') + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(ISNULL(h.LocalNetTotal, h.NetTotal),0) AS decimal(19,2))) + CHAR(31) +
       CAST((SELECT COUNT(*) FROM ${d} q WHERE q.DocKey = h.DocKey) AS varchar(12)) + CHAR(31) +
       LTRIM(RTRIM(ISNULL(h.CurrencyCode,''))) + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(h.CurrencyRate,0) AS decimal(19,6))) + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(h.NetTotal,0) AS decimal(19,2)))
  FROM ${h} h
 ORDER BY h.DocNo`;

/* Line projection.  Every type emits the SAME 12 fields; the ones a type does
   not have come out empty, so the parser needs no per-type arity.  itemKey
   falls back to the Description when ItemCode is blank — 1,316 of 62,697
   SODTL rows were code-less on 2026-09-07 (AutoCount's non-stock lines), and
   the ERP importer carried a description into item_code for exactly those.
   hasCode records which of the two it was, so the checker can keep code-less
   lines out of the item-code mismatch count. */
function lineSql(h, d, opts) {
  const transfered = opts.transfered ? "d.TransferedQty" : "NULL";
  const fromType = opts.fromDoc ? "ISNULL(d.FromDocType,'')" : "''";
  const fromNo = opts.fromDoc ? "LTRIM(RTRIM(ISNULL(d.FromDocNo,'')))" : "''";
  const fromSoDtl = opts.fromSoDtlKey ? "ISNULL(CAST(d.FromSODtlKey AS varchar(20)),'')" : "''";
  return `
SELECT LTRIM(RTRIM(ISNULL(h.DocNo,''))) + CHAR(31) +
       CAST(d.DtlKey AS varchar(20)) + CHAR(31) +
       CAST(ISNULL(d.Seq,0) AS varchar(12)) + CHAR(31) +
       REPLACE(REPLACE(REPLACE(
         ISNULL(NULLIF(CAST(LTRIM(RTRIM(ISNULL(d.ItemCode,''))) AS varchar(120)),''),
                CAST(LEFT(ISNULL(d.Description,''),120) AS varchar(120))),
         CHAR(13),' '), CHAR(10),' '), CHAR(31),' ') + CHAR(31) +
       CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(d.ItemCode,''))),'') IS NULL THEN '0' ELSE '1' END + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(d.Qty,0) AS decimal(19,4))) + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(d.UnitPrice,0) AS decimal(19,4))) + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(ISNULL(d.LocalSubTotal, d.SubTotal),0) AS decimal(19,2))) + CHAR(31) +
       ISNULL(CONVERT(varchar(32), CAST(${transfered} AS decimal(19,4))),'') + CHAR(31) +
       ${fromType} + CHAR(31) +
       ${fromNo} + CHAR(31) +
       ${fromSoDtl} + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(d.SubTotal,0) AS decimal(19,2))) + CHAR(31) +
       LTRIM(RTRIM(ISNULL(d.Location,'')))
  FROM ${d} d JOIN ${h} h ON h.DocKey = d.DocKey
 ORDER BY h.DocNo, d.Seq, d.DtlKey`;
}

/* Desc2, in bounded key windows.
 *
 * Each window is one clustered-index range on DtlKey with BOTH ends stated, so
 * the amount of book a single statement can touch is decided here and not by
 * the optimiser.  Blank Desc2 is dropped in SQL rather than shipped and
 * discarded: 83,576 of 220,663 detail lines carried one on 2026-09-07, so the
 * filter is most of the transport.
 *
 * The LENGTH travels beside the text as its own field.  sqlcmd truncates a
 * column silently at its display width, and a checker fed a HALF Desc2 would
 * decode a half build and report the difference as an ERP defect.  The length
 * is measured in SQL over the value AFTER the same CR/LF/US replacements the
 * transport applies, so the two sides are the same string and any disagreement
 * is transport loss rather than an artefact of trimming. */
function desc2Rows(d, label) {
  const bounds = rows(
    `SELECT CAST(ISNULL(MIN(DtlKey),0) AS varchar(20)) + CHAR(31) + CAST(ISNULL(MAX(DtlKey),-1) AS varchar(20)) FROM ${d}`,
    2,
    DESC2_TIMEOUT_S,
  );
  const lo0 = Number(bounds[0][0]);
  const hi0 = Number(bounds[0][1]);
  const out = [];
  let windows = 0;
  let narrowed = 0;
  const short = [];
  /* CHAR(9) is in this list for a measured reason, not for tidiness: PODTL
     DtlKey 721957 ends with two TABS, and LEN() ignores trailing SPACES but
     NOT trailing tabs, so the book said 63 characters while the transport
     delivered 61 and the guard below refused the whole export (2026-09-07).
     Turning a tab into a space makes both sides drop exactly the same
     characters. No decoder reads a tab as information. */
  const CLEAN = "REPLACE(REPLACE(REPLACE(REPLACE(d.Desc2, CHAR(13),' '), CHAR(10),' '), CHAR(9),' '), CHAR(31),' ')";
  const window = (lo, hi) => rows(
    `
SELECT CAST(d.DtlKey AS varchar(20)) + CHAR(31) +
       CAST(LEN(${CLEAN}) AS varchar(8)) + CHAR(31) +
       ${CLEAN}
  FROM ${d} d
 WHERE d.DtlKey > ${lo} AND d.DtlKey <= ${hi}
   AND LTRIM(RTRIM(ISNULL(d.Desc2,''))) <> ''
 ORDER BY d.DtlKey`,
    3,
    DESC2_TIMEOUT_S,
  );
  /* A window that will not answer in 15 seconds NARROWS; the timeout never
     grows. The book is production and other work runs against it - on
     2026-09-07 a 40,000-key window timed out mid-export while three other
     agents were reading it - so the right answer to "the book is busy" is to
     ask for less of it and to wait longer before asking again. Below
     DESC2_MIN_WINDOW it gives up rather than hammering: something is wrong that
     a smaller SELECT will not fix. */
  const windowWithBackoff = (lo, hi) => {
    let width = hi - lo;
    for (;;) {
      try {
        const acc = [];
        for (let a = lo; a < hi; a += width) acc.push(...window(a, Math.min(a + width, hi)));
        return acc;
      } catch (e) {
        if (width <= DESC2_MIN_WINDOW) throw e;
        width = Math.max(DESC2_MIN_WINDOW, Math.floor(width / 4));
        narrowed++;
        pause(DESC2_PAUSE_MS * 10);
      }
    }
  };
  for (let lo = lo0 - 1; lo < hi0; lo += DESC2_WINDOW) {
    const hi = Math.min(lo + DESC2_WINDOW, hi0);
    const batch = windowWithBackoff(lo, hi);
    windows++;
    for (const [key, len, text] of batch) {
      /* LEN() ignores TRAILING spaces, and sqlcmd's -W trims them off the row,
         so both sides drop exactly the same characters.  A shortfall is the
         transport losing text. */
      const got = text.replace(/\s+$/, "");
      if (got.length < Number(len)) short.push(`${key} (book ${len} chars, transport ${got.length})`);
      out.push([key, got]);
    }
    pause(DESC2_PAUSE_MS);
  }
  if (short.length) {
    throw new Error(
      `${label}: ${short.length} Desc2 values came back shorter than the book's own length ` +
        `(first: ${short.slice(0, 3).join("; ")}). sqlcmd truncated them; a checker fed a half ` +
        "build would report a false variant defect. Refusing.",
    );
  }
  return { rows: out, windows, narrowed };
}

const TYPES = [
  { t: "SO", h: "SO", d: "SODTL", opts: { transfered: true } },
  { t: "PO", h: "PO", d: "PODTL", opts: { transfered: true, fromDoc: true, fromSoDtlKey: true } },
  { t: "GR", h: "GR", d: "GRDTL", opts: { fromDoc: true } },
  { t: "DO", h: "DO", d: "DODTL", opts: { fromDoc: true } },
  { t: "IV", h: "IV", d: "IVDTL", opts: { fromDoc: true } },
  { t: "PI", h: "PI", d: "PIDTL", opts: { fromDoc: true } },
];

const snapshot = {
  exported_at: new Date().toISOString(),
  source: `${DB} live (read-only)`,
  grain: "one row per AutoCount DocNo (headers) and per DtlKey (lines); NO filtering",
  /* `netTotal` / `subTotal` are the LOCAL-currency (MYR) amounts and always
     were; `currency`, `rate`, `docTotal` and `docSubTotal` were APPENDED
     2026-09-07 so a consumer can say which of the two it means instead of being
     handed one and left to assume.  Appended, never reordered: `decodeSnapshot`
     indexes these by NAME, so an older snapshot decodes with the new fields
     null — which is what lets a consumer refuse a currency-blind cut rather than
     read a missing column as "MYR".  Ledger: docs/bugs/0665-*.md. */
  header_fields: ["docNo", "docDate", "cancelled", "netTotal", "lineCount", "currency", "rate", "docTotal"],
  line_fields: [
    "docNo", "dtlKey", "seq", "itemKey", "hasCode",
    "qty", "unitPrice", "subTotal", "transferedQty",
    "fromDocType", "fromDocNo", "fromSoDtlKey",
    "docSubTotal",
    /* APPENDED 2026-09-07 for the delivery line's WAREHOUSE. AutoCount records
       a Location on every detail row and the ERP had nowhere to put it, so the
       reconcile reported it as `line location [NOT-C]`. The owner ruled that
       those codes ARE our stock warehouses, so the value now has a column
       (mig 20260907T2345) and this is the field that feeds it. Appended, never
       reordered, for the same reason as the currency fields above. */
    "location",
  ],
  /* Present ONLY on a snapshot cut by this version or later.  The variant
     reconcile keys off its absence to refuse rather than report a clean run
     against a book whose build text it never read. */
  desc2_fields: ["dtlKey", "desc2"],
  desc2_grain: "one row per DtlKey whose <DTL>.Desc2 is not blank; blank Desc2 is omitted, not empty-stringed",
  counts: {},
  types: {},
};

for (const { t, h, d, opts } of TYPES) {
  const t0 = Date.now();
  const hdr = rows(headerSql(h, d), snapshot.header_fields.length);
  const lns = rows(lineSql(h, d, opts), snapshot.line_fields.length);
  const d2 = desc2Rows(d, t);
  snapshot.types[t] = { headers: hdr, lines: lns, desc2: d2.rows };
  snapshot.counts[t] = { headers: hdr.length, lines: lns.length, desc2: d2.rows.length };
  console.log(
    `${t}: ${hdr.length} headers, ${lns.length} lines, ${d2.rows.length} Desc2 ` +
      `(${d2.windows} key windows of ${DESC2_WINDOW}` +
      `${d2.narrowed ? `, ${d2.narrowed} narrowed because the book was busy` : ""}) ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

const dest = path.join(OUT, "ac-reconcile-truth.json.gz");
fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 }));
console.log(`wrote ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(2)} MB)`);
