#!/usr/bin/env node
/* export-ac-convert-edges — the AutoCount side of check-ac-convert-symmetry.mjs.
 *
 * The owner's question (2026-09-07): "记得检查我们的 convert（也就是 transfer from
 * 和 transfer to）的功能对称。你相互检查看一下，transfer to 和 transfer from 的功能
 * 全部都是准确的吗？数据是准确的吗？"  Two directions, and whether they AGREE.
 *
 * WHY THIS IS NOT A COLUMN ADDED TO export-ac-reconcile-truth.mjs.  That
 * exporter's snapshot answers a different question and is refreshed on its own
 * cadence (a FINAL cut was in flight as PR #3044 when this was written).
 * Widening its projection would collide with that cut on the same committed
 * .gz.  This is a separate, much cheaper pull — no Desc2, no prices, no
 * totals — so it can be re-run after the delta import lands without re-reading
 * the build text.
 *
 * WHAT THE RECONCILE SNAPSHOT CANNOT ANSWER, measured on the live book
 * 2026-09-07, and why each column below exists:
 *
 *   1. `SODTL.TransferedPOQty` is a SEPARATE counter from `SODTL.TransferedQty`.
 *      TransferedQty is the DO/IV counter (47,750 lines > 0); TransferedPOQty is
 *      the PO counter (10,786 lines > 0), matching PODTL.FromSODtlKey's 10,789
 *      rows.  A check that compared PO children against TransferedQty would be
 *      reading the DELIVERY counter and calling the difference a defect.
 *
 *   2. `DODTL.TransferedQty` and `GRDTL.TransferedQty` ARE populated on this
 *      book — 43,378 of 48,772 and 21,450 of 21,746 respectively.  The
 *      reconcile exporter projects both as NULL (`{ transfered: true }` is set
 *      only for SO and PO), so that snapshot is structurally blind to the
 *      parent side of the DO->IV and GR->PI edges.  Both are pulled here.
 *
 *   3. `FromDocDtlKey` exists on ALL SIX detail tables and is NULL on EVERY ONE
 *      of the ~220,000 rows.  It is exported anyway, precisely so the checker
 *      can PROVE that rather than assume it.
 *
 *      ⚠️ CORRECTED 2026-09-09.  This bullet used to end: *"the day the
 *      write-back starts populating it, line-level resolution becomes possible
 *      for the other four edges"* — which reads as "until then, the book cannot
 *      say".  The book CAN say, and always could.  AutoCount keeps the
 *      line-to-line graph in `DocTransfer`, not in the detail tables: 134,501
 *      rows on this book, `FromDocDtlKey` and `ToDocDtlKey` set on every one,
 *      exactly one source per child.  `export-ac-doc-transfer.mjs` pulls it and
 *      `docs/bugs/0746` has the measurement.  This exporter is deliberately NOT
 *      changed to read it — several lanes read this committed .gz and filling
 *      the column would move every downstream verdict at once — so the two
 *      snapshots stay separate and this bullet stays a statement about the
 *      DETAIL TABLES only.
 *
 * THE TRAP THIS EXPORT EXISTS TO RECORD.  `PODTL.FromDocType` is NULL on all
 * 10,789 real SO->PO rows in this book.  AutoCount records that one edge as
 * `FromSODtlKey` + `FromDocNo` and does NOT stamp a FromDocType, even on a
 * document the SDK created minutes ago.  Every other edge (DO<-SO, IV<-DO,
 * IV<-SO, GR<-PO, PI<-GR) does carry it.  A checker that tests `FromDocType`
 * uniformly reports a false failure on the SO->PO edge; qa-matrix.ps1 did
 * exactly that.
 *
 * READ-ONLY.  SELECT only, statement timeout on every read, bounded key windows
 * on the line pulls.  Staff keep working in AutoCount while this runs, and an
 * unbounded scan of this book is what made SalesOrder.InternalSave() time out
 * on 2026-09-07.
 *
 * Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB   (default AED_HOUZS)
 *       AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
 *       SQLCMD  (default the SQL Server 110 client path)
 *       OUT_DIR (default: this script's data/)
 *       AC_LINE_WINDOW    (default 40000 DtlKeys per batch)
 *       AC_PAUSE_MS       (default 200ms between batches)
 *       AC_STMT_TIMEOUT_S (default 120s)
 *
 * Usage:  AC_CRED_FILE=<path> node backend/scripts/export-ac-convert-edges.mjs
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
const PWD = fs.readFileSync(CRED, "utf8").trim();

const US = "\u001f";
const WINDOW = Number(process.env.AC_LINE_WINDOW || 40000);
const PAUSE_MS = Number(process.env.AC_PAUSE_MS || 200);
const MIN_WINDOW = 2500;
const TIMEOUT_S = Number(process.env.AC_STMT_TIMEOUT_S || 120);

/* sqlcmd is a Windows program so its output is CRLF; a runner reading it on
   Linux is not. Built from char codes so the escape survives every editor and
   patch tool this file passes through - it did not, twice, on 2026-09-07. */
const NEWLINE = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));
const TRANSIENT =
  /Timeout expired|Communication link failure|forcibly closed|transport-level error|Login timeout expired/i;

/* THE PASSWORD IS IN THE ARGV AND NODE PUTS THE ARGV IN THE ERROR MESSAGE.
   execFileSync builds its message as "Command failed: <the whole command
   line>", so ANY non-zero sqlcmd exit used to print `-P <password>` into
   whatever is reading stdout. Everything that could carry it out of this
   process goes through here first. PWD is checked for emptiness because
   String.split("").join() would insert the replacement between every char. */
const scrub = (text) => (PWD ? String(text).split(PWD).join("<redacted>") : String(text));

const pause = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function rowsOnce(sql, expectFields, timeoutSec) {
  const f = path.join(os.tmpdir(), `ac-edges-${process.pid}-${Math.random().toString(36).slice(2)}.sql`);
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
    /* The excerpt is CAPPED: sqlcmd writes the rows it managed to send before
       it died, and pasting thousands of them buries the line that says why. */
    const said = e.stdout
      ? scrub(String(e.stdout)).trim().split(NEWLINE).slice(-3).join(" / ").slice(0, 300)
      : "";
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
       mangled it. A checker fed a silently short row would report a false
       mismatch. Refuse. */
    if (parts.length !== expectFields) {
      throw new Error(`malformed row (${parts.length} fields, expected ${expectFields}): ${line.slice(0, 160)}`);
    }
    parsed.push(parts);
  }
  return parsed;
}

/* A dropped ZeroTier tunnel or a statement the busy server would not finish is
   not a defect in the query, so ask again — three times, waiting longer each
   time, and never by relaxing the timeout. Anything else (a syntax error, a
   wrong column, a bad login) throws on the first attempt. */
function rows(sql, expectFields, timeoutSec = TIMEOUT_S) {
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

/* Every line pull is a BOUNDED clustered-index range on DtlKey with both ends
   stated, so how much book one statement can touch is decided here and not by
   the optimiser. A window that will not answer NARROWS; the timeout never
   grows — the right answer to "the book is busy" is to ask for less of it.
   Below MIN_WINDOW it gives up rather than hammering: something is wrong that
   a smaller SELECT will not fix. */
function windowed(sql, expectFields, table, label) {
  const b = rows(
    `SELECT CAST(ISNULL(MIN(DtlKey),0) AS varchar(20)) + CHAR(31) + CAST(ISNULL(MAX(DtlKey),-1) AS varchar(20)) FROM ${table}`,
    2,
  );
  const lo0 = Number(b[0][0]);
  const hi0 = Number(b[0][1]);
  const out = [];
  let windows = 0;
  let narrowed = 0;
  for (let lo = lo0 - 1; lo < hi0; lo += WINDOW) {
    const hi = Math.min(lo + WINDOW, hi0);
    let width = hi - lo;
    for (;;) {
      try {
        const acc = [];
        for (let a = lo; a < hi; a += width) acc.push(...rows(sql(a, Math.min(a + width, hi)), expectFields));
        out.push(...acc);
        break;
      } catch (e) {
        if (width <= MIN_WINDOW) throw e;
        width = Math.max(MIN_WINDOW, Math.floor(width / 4));
        narrowed++;
        pause(PAUSE_MS * 10);
      }
    }
    windows++;
    pause(PAUSE_MS);
  }
  console.log(`  ${label}: ${out.length} rows in ${windows} window(s)${narrowed ? `, ${narrowed} narrowed` : ""}`);
  return out;
}

const headerSql = (h) => `
SELECT LTRIM(RTRIM(ISNULL(h.DocNo,''))) + CHAR(31) +
       ISNULL(CONVERT(varchar(10), h.DocDate, 23),'') + CHAR(31) +
       ISNULL(h.Cancelled,'F')
  FROM ${h} h
 ORDER BY h.DocNo`;

/* Twelve fields for every type; a column a type does not have comes out empty,
   so the parser needs no per-type arity. itemKey falls back to Description for
   AutoCount's code-less non-stock lines, exactly as the reconcile exporter
   does, so the two snapshots group on the same key. */
const lineSql = (h, d, o) => (lo, hi) => `
SELECT LTRIM(RTRIM(ISNULL(hh.DocNo,''))) + CHAR(31) +
       CAST(d.DtlKey AS varchar(20)) + CHAR(31) +
       CAST(ISNULL(d.Seq,0) AS varchar(12)) + CHAR(31) +
       REPLACE(REPLACE(REPLACE(
         ISNULL(NULLIF(CAST(LTRIM(RTRIM(ISNULL(d.ItemCode,''))) AS varchar(120)),''),
                CAST(LEFT(ISNULL(d.Description,''),120) AS varchar(120))),
         CHAR(13),' '), CHAR(10),' '), CHAR(31),' ') + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(d.Qty,0) AS decimal(19,4))) + CHAR(31) +
       ISNULL(CONVERT(varchar(32), CAST(d.TransferedQty AS decimal(19,4))),'') + CHAR(31) +
       ${o.poQty ? "ISNULL(CONVERT(varchar(32), CAST(d.TransferedPOQty AS decimal(19,4))),'')" : "''"} + CHAR(31) +
       LTRIM(RTRIM(ISNULL(CAST(d.Transferable AS varchar(8)),''))) + CHAR(31) +
       ${o.fromDoc ? "ISNULL(d.FromDocType,'')" : "''"} + CHAR(31) +
       ${o.fromDoc ? "LTRIM(RTRIM(ISNULL(d.FromDocNo,'')))" : "''"} + CHAR(31) +
       ISNULL(CAST(d.FromDocDtlKey AS varchar(20)),'') + CHAR(31) +
       ${o.fromSo ? "ISNULL(CAST(d.FromSODtlKey AS varchar(20)),'')" : "''"}
  FROM ${d} d JOIN ${h} hh ON hh.DocKey = d.DocKey
 WHERE d.DtlKey > ${lo} AND d.DtlKey <= ${hi}
 ORDER BY d.DtlKey`;

/* `TransferedQty` is projected for ALL SIX: DODTL and GRDTL carry a populated
   one on this book (43,378 and 21,450 rows > 0) even though the reconcile
   exporter projects them NULL. `poQty` is SO-only (TransferedPOQty exists on
   SODTL alone); `fromSo` is PO-only; SODTL has no FromDoc* worth reading
   because nothing converts INTO a sales order — it is the root. */
const TYPES = [
  { t: "SO", h: "SO", d: "SODTL", o: { poQty: true } },
  { t: "PO", h: "PO", d: "PODTL", o: { fromDoc: true, fromSo: true } },
  { t: "GR", h: "GR", d: "GRDTL", o: { fromDoc: true } },
  { t: "DO", h: "DO", d: "DODTL", o: { fromDoc: true } },
  { t: "IV", h: "IV", d: "IVDTL", o: { fromDoc: true } },
  { t: "PI", h: "PI", d: "PIDTL", o: { fromDoc: true } },
];

const snapshot = {
  exported_at: new Date().toISOString(),
  source: `${DB} live (read-only)`,
  grain: "one row per AutoCount DocNo (headers) and per DtlKey (lines); NO filtering",
  header_fields: ["docNo", "docDate", "cancelled"],
  line_fields: [
    "docNo", "dtlKey", "seq", "itemKey", "qty",
    "transferedQty", "transferedPoQty", "transferable",
    "fromDocType", "fromDocNo", "fromDocDtlKey", "fromSoDtlKey",
  ],
  counts: {},
  types: {},
};

console.log(`export-ac-convert-edges -> ${DB} @ ${HOST}`);
for (const { t, h, d, o } of TYPES) {
  console.log(`${t}:`);
  const headers = rows(headerSql(h), 3);
  console.log(`  headers: ${headers.length}`);
  const lines = windowed(lineSql(h, d, o), 12, d, "lines");
  snapshot.types[t] = { headers, lines };
  snapshot.counts[t] = { headers: headers.length, lines: lines.length };
}

fs.mkdirSync(OUT, { recursive: true });
const dest = path.join(OUT, "ac-convert-edges.json.gz");
fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 }));
console.log(`\nwrote ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(2)} MB)`);
console.log(JSON.stringify(snapshot.counts, null, 1));
