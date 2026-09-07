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
 * an AutoCount Description is a parser waiting to lie.  CR/LF and CHAR(31)
 * inside a description are replaced with a space before the join for the same
 * reason.  -W trims sqlcmd's column padding; -y is NOT passed (sqlcmd refuses
 * -W and -y together) and the longest SODTL Description measured 2026-09-07
 * was 86 chars, inside sqlcmd's 256-char default width for a varchar
 * expression.
 *
 * Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB   (default AED_HOUZS)
 *       AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
 *       SQLCMD  (default the SQL Server 110 client path)
 *       OUT_DIR (default: this script's data/)
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

/* Runs one SELECT and returns rows already split on the unit separator.  The
   query goes through a temp -i file: a long statement on a Windows command
   line is a quoting minefield, and -Q would put it there. */
function rows(sql, expectFields) {
  const f = path.join(
    os.tmpdir(),
    `ac-recon-${process.pid}-${Math.random().toString(36).slice(2)}.sql`,
  );
  fs.writeFileSync(f, `SET NOCOUNT ON;\n${sql}\n`, "utf8");
  let out;
  try {
    out = execFileSync(
      SQLCMD,
      ["-S", HOST, "-d", DB, "-U", USER, "-P", PWD, "-h", "-1", "-W", "-w", "65535", "-b", "-i", f],
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
    );
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

/* Header projection, identical for all six types. */
const headerSql = (h, d) => `
SELECT LTRIM(RTRIM(ISNULL(h.DocNo,''))) + CHAR(31) +
       ISNULL(CONVERT(varchar(10), h.DocDate, 23),'') + CHAR(31) +
       ISNULL(h.Cancelled,'F') + CHAR(31) +
       CONVERT(varchar(32), CAST(ISNULL(ISNULL(h.LocalNetTotal, h.NetTotal),0) AS decimal(19,2))) + CHAR(31) +
       CAST((SELECT COUNT(*) FROM ${d} q WHERE q.DocKey = h.DocKey) AS varchar(12))
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
       ${fromSoDtl}
  FROM ${d} d JOIN ${h} h ON h.DocKey = d.DocKey
 ORDER BY h.DocNo, d.Seq, d.DtlKey`;
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
  header_fields: ["docNo", "docDate", "cancelled", "netTotal", "lineCount"],
  line_fields: [
    "docNo", "dtlKey", "seq", "itemKey", "hasCode",
    "qty", "unitPrice", "subTotal", "transferedQty",
    "fromDocType", "fromDocNo", "fromSoDtlKey",
  ],
  counts: {},
  types: {},
};

for (const { t, h, d, opts } of TYPES) {
  const t0 = Date.now();
  const hdr = rows(headerSql(h, d), 5);
  const lns = rows(lineSql(h, d, opts), 12);
  snapshot.types[t] = { headers: hdr, lines: lns };
  snapshot.counts[t] = { headers: hdr.length, lines: lns.length };
  console.log(
    `${t}: ${hdr.length} headers, ${lns.length} lines (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

const dest = path.join(OUT, "ac-reconcile-truth.json.gz");
fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 }));
console.log(`wrote ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(2)} MB)`);
