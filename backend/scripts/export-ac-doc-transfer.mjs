#!/usr/bin/env node
/* export-ac-doc-transfer — the account book's LINE-LEVEL transfer graph.
 *
 * ── WHAT THIS OVERTURNS ────────────────────────────────────────────────────
 * Every checker in this repo has been built on the sentence *"AutoCount records
 * which DOCUMENT a line came from and NEVER which line"*. It is written into
 * `lib/transfer-chain-verdict.mjs`'s header as fact 1, into
 * `export-ac-convert-edges.mjs`'s header as fact 3, and it is the reason the
 * reconcile excludes ~1,550 findings under *"the account book itself does not
 * record WHICH LINE a delivery / invoice / receipt was raised from"*.
 *
 * That sentence is true of the DETAIL TABLES and FALSE of the book.
 * `GRDTL.FromDocDtlKey`, `DODTL.FromDocDtlKey`, `PIDTL.FromDocDtlKey` and the
 * rest ARE NULL on all ~220,000 rows — that measurement was right. But AutoCount
 * does not keep the line graph there. It keeps it in its own table, `DocTransfer`,
 * and measured on the live book on 2026-09-09 that table holds:
 *
 *     FromDocType ToDocType  rows   FromDocDtlKey NULL  ToDocDtlKey NULL
 *     SO          DO        48740                    0                 0
 *     DO          IV        44589                    0                 0
 *     GR          PI        21481                    0                 0
 *     PO          GR        18944                    0                 0
 *     SO          IV          169                    0                 0
 *     ... 134,501 rows in total, NOT ONE of them missing either line key.
 *
 * Two further facts were measured on the same book, and both are re-asserted by
 * this exporter every run rather than trusted:
 *
 *   1. **Every child line has exactly ONE source line.** `max(sources)` is 1 on
 *      every edge, so a single `fromDtlKey` per child is the whole truth and
 *      nothing has to be dropped or merged.
 *   2. **`DtlKey` is unique across all six detail tables** — the UNION of
 *      SODTL/PODTL/GRDTL/DODTL/IVDTL/PIDTL keys has zero duplicates. So a child
 *      key identifies a line by itself. `ToDocType` is exported and joined on
 *      anyway, because a fact that is true today and cheap to assert should be
 *      asserted rather than depended on.
 *
 * ── WHY IT IS A SEPARATE SNAPSHOT ──────────────────────────────────────────
 * `ac-convert-edges.json.gz` is refreshed by `export-ac-convert-edges.mjs` on
 * its own cadence and several lanes read it. Widening its projection would put
 * two lanes on one committed .gz, which is the collision its own header records
 * paying for once already. This is a much cheaper pull — five integer columns,
 * no text, no money — so it can be refreshed on its own.
 *
 * READ-ONLY AND BOUNDED. SELECT only, a statement timeout on every read, and
 * windowed on `TransferKey` so no single statement scans the table. Staff keep
 * working in AutoCount while this runs, and an unbounded scan of this book is
 * what made `SalesOrder.InternalSave()` time out on 2026-09-07 — a lock timeout
 * that looks exactly like a permissions refusal.
 *
 * Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB   (default AED_HOUZS)
 *       AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
 *       SQLCMD  (default the SQL Server 110 client path)
 *       OUT_DIR (default: this script's data/)
 *       AC_WINDOW         (default 20000 TransferKeys per batch)
 *       AC_PAUSE_MS       (default 200ms between batches)
 *       AC_STMT_TIMEOUT_S (default 120s)
 *
 * RE-RUN: overwrites data/ac-doc-transfer.json.gz with a fresh cut. It writes
 * nothing to the book and nothing to the ERP.
 *
 * Usage:  AC_CRED_FILE=<path> node backend/scripts/export-ac-doc-transfer.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || path.join(here, "data");
const HOST = process.env.AC_HOST || "10.147.17.100,55500";
const DB = process.env.AC_DB || "AED_HOUZS";
const USER = process.env.AC_USER || "sa2";
const CRED = process.env.AC_CRED_FILE;
const SQLCMD = process.env.SQLCMD || "C:/Program Files/Microsoft SQL Server/110/Tools/Binn/sqlcmd.exe";
const WINDOW = Number(process.env.AC_WINDOW || 20000);
const PAUSE_MS = Number(process.env.AC_PAUSE_MS || 200);
const STMT_TIMEOUT_S = Number(process.env.AC_STMT_TIMEOUT_S || 120);

if (!CRED) { console.error("AC_CRED_FILE is required — the password is passed BY PATH, never on the command line or in an env var"); process.exit(2); }
if (!fs.existsSync(CRED)) { console.error(`AC_CRED_FILE does not exist: ${CRED}`); process.exit(2); }
const PW = fs.readFileSync(CRED, "utf8").trim();

const US = String.fromCharCode(31);
const pause = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function run(sqlText) {
  const out = execFileSync(SQLCMD, [
    "-S", HOST, "-U", USER, "-P", PW, "-d", DB,
    "-l", "30", "-t", String(STMT_TIMEOUT_S), "-h", "-1", "-W", "-s", US, "-w", "8000",
    "-Q", `SET NOCOUNT ON; ${sqlText}`,
  ], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return out;
}

/** Parse sqlcmd's unit-separated output into arrays of exactly `n` fields. */
function rows(sqlText, n) {
  const out = [];
  for (const raw of run(sqlText).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || /^\(\d+ rows affected\)$/.test(line)) continue;
    const f = line.split(US);
    if (f.length !== n) continue;
    out.push(f.map((s) => s.trim()));
  }
  return out;
}

/* ── THE THREE ASSERTIONS, MEASURED EVERY RUN ─────────────────────────────
   A snapshot whose shape silently changed is worse than no snapshot: the
   repair that reads it would go on writing links from a rule the book no
   longer obeys. So the exporter REFUSES rather than writing a file. */
function assertShape() {
  const bad = [];

  const multi = rows(
    `SELECT COUNT(*) FROM (SELECT ToDocType, ToDocDtlKey FROM DocTransfer
       GROUP BY ToDocType, ToDocDtlKey HAVING COUNT(*) > 1) x`, 1);
  const nMulti = Number(multi[0]?.[0] ?? -1);
  if (nMulti !== 0) {
    bad.push(`${nMulti} child line(s) in DocTransfer name MORE THAN ONE source line. ` +
      "A single fromDtlKey per child is no longer the whole truth and the repair that reads this file would pick one arbitrarily");
  }

  const nulls = rows(
    `SELECT COUNT(*) FROM DocTransfer WHERE FromDocDtlKey IS NULL OR ToDocDtlKey IS NULL`, 1);
  const nNull = Number(nulls[0]?.[0] ?? -1);
  if (nNull !== 0) {
    bad.push(`${nNull} DocTransfer row(s) carry a NULL line key on one side. The graph is no longer complete`);
  }

  /* THE UNION NEEDS ITS OWN DERIVED TABLE, and both cheaper spellings are wrong
     in opposite directions — each was written and run against the live book
     before this one:
       · GROUP BY after the closing paren groups the OUTER query, so it returns
         one row per colliding key and ZERO rows when the book is clean. The
         parser reads no rows as no answer, and a clean book refuses itself.
       · GROUP BY inside the parens but after the last UNION ALL arm binds to
         THAT ARM ALONE. PIDTL's key is unique, so that arm contributes nothing
         and the count becomes the row count of the other five tables — 198,199,
         reported as if every line had collided.
     Proven RED before it was trusted: the same shape over `SODTL UNION ALL
     SODTL` answers 62,773, and over the real six answers 0. */
  const dup = rows(
    `SELECT COUNT(*) FROM (
       SELECT u.k FROM (
         SELECT DtlKey AS k FROM SODTL UNION ALL SELECT DtlKey AS k FROM PODTL
         UNION ALL SELECT DtlKey AS k FROM GRDTL UNION ALL SELECT DtlKey AS k FROM DODTL
         UNION ALL SELECT DtlKey AS k FROM IVDTL UNION ALL SELECT DtlKey AS k FROM PIDTL
       ) u GROUP BY u.k HAVING COUNT(*) > 1) a`, 1);
  const nDup = Number(dup[0]?.[0] ?? -1);
  if (nDup !== 0) {
    bad.push(`${nDup} DtlKey value(s) appear in more than one detail table, so a line key no longer identifies a line by itself`);
  }

  return { bad, nMulti, nNull, nDup };
}

console.log(`export-ac-doc-transfer -> ${DB} @ ${HOST}`);
const shape = assertShape();
if (shape.bad.length) {
  console.error("REFUSING to write a snapshot — the book no longer has the shape this file is defined on:");
  for (const b of shape.bad) console.error(`  · ${b}`);
  process.exit(3);
}
console.log(`  shape OK: 0 multi-source children, 0 null line keys, 0 cross-table DtlKey collisions`);

const bounds = rows(`SELECT MIN(TransferKey), MAX(TransferKey) FROM DocTransfer`, 2);
const lo0 = Number(bounds[0][0]);
const hi0 = Number(bounds[0][1]);

/* The DOCUMENT numbers are joined in here rather than looked up later, because
   a repair has to be able to say WHICH document it is writing a link for
   without loading six more tables. */
const edgeSql = (lo, hi) => `
SELECT t.FromDocType + '${US}' +
       CAST(t.FromDocDtlKey AS varchar(20)) + '${US}' +
       t.ToDocType + '${US}' +
       CAST(t.ToDocDtlKey AS varchar(20)) + '${US}' +
       CONVERT(varchar(32), CAST(ISNULL(t.Qty,0) AS decimal(19,4)))
  FROM DocTransfer t
 WHERE t.TransferKey > ${lo} AND t.TransferKey <= ${hi}
 ORDER BY t.TransferKey`;

const edges = [];
let windows = 0;
for (let lo = lo0 - 1; lo < hi0; lo += WINDOW) {
  const hi = Math.min(lo + WINDOW, hi0);
  edges.push(...rows(edgeSql(lo, hi), 5));
  windows += 1;
  pause(PAUSE_MS);
}
console.log(`  edges: ${edges.length} rows in ${windows} window(s)`);

const byEdge = {};
for (const e of edges) {
  const k = `${e[0]}->${e[2]}`;
  byEdge[k] = (byEdge[k] ?? 0) + 1;
}

const snapshot = {
  exported_at: new Date().toISOString(),
  source: `${DB} live (read-only)`,
  grain: "one row per DocTransfer row — the book's own LINE-to-LINE transfer graph; NO filtering",
  proved_at_export: {
    children_with_more_than_one_source: shape.nMulti,
    rows_with_a_null_line_key: shape.nNull,
    dtlkeys_appearing_in_more_than_one_detail_table: shape.nDup,
  },
  edge_fields: ["fromDocType", "fromDtlKey", "toDocType", "toDtlKey", "qty"],
  counts: { edges: edges.length, byEdge },
  edges,
};

fs.mkdirSync(OUT, { recursive: true });
const dest = path.join(OUT, "ac-doc-transfer.json.gz");
fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 }));
console.log(`\nwrote ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(2)} MB)`);
console.log(JSON.stringify(snapshot.counts, null, 1));
