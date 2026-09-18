# -*- coding: utf-8 -*-
"""
count-ac-line-pictures.py — how many lines of EVERY document type carry a
drawing pasted into `FurtherDescription`.

WHY THIS EXISTS. `export-ac-line-photos.py` reads that field for `SODTL` and
`PODTL` only. The column exists on all six detail tables, and until 2026-09-09
nobody had ever asked whether the other four carry pictures too. They do:

    GRDTL 2,337   DODTL 2,194   IVDTL 1,952   PIDTL 2,298

Every one of those has never been exported, so every conclusion of the form
"the account book does not state it" that was drawn about a goods receipt, a
delivery order or an invoice rested on an export that never looked there.

READ-ONLY, AND IT CANNOT BLOCK THE WRITE-BACK. Two deliberate properties, both
of them load-bearing:

  · READ UNCOMMITTED + WITH (NOLOCK) — it takes no shared locks at all, so it
    cannot starve `SalesOrder.InternalSave`. A wide read of this column has
    done exactly that before, and the resulting HTTP 500 looks IDENTICAL to a
    permissions refusal while actually being a lock timeout.
  · Bounded `DtlKey` windows, and the RTF body is NEVER selected. Only
    `COUNT(*)` and `DATALENGTH()` cross the wire. One `FurtherDescription`
    measured here is 1,508,142 bytes; pulling them in bulk is the mistake.

Env:  AC_HOST (default 10.147.17.100,55500)  AC_DB (default AED_HOUZS)
      AC_USER (default sa2)   AC_CRED_FILE (password file, required — by PATH,
      never printed)          WIN (DtlKey window size, default 50000)
      DOCS (optional: comma-separated book DocNos; counts per document instead)

Usage:
  AC_CRED_FILE=<path> python backend/scripts/count-ac-line-pictures.py
  AC_CRED_FILE=<path> DOCS=GR-005306,DO-011518 python backend/scripts/count-ac-line-pictures.py
"""
import os
import sys
import time

import pyodbc

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
WIN = int(os.environ.get("WIN", "50000") or 50000)
DOCS = [d.strip() for d in os.environ.get("DOCS", "").split(",") if d.strip()]

# Detail table -> header table. All six, so the two the exporter already covers
# are printed as the CONTROL: if SODTL/PODTL ever stop matching the exporter's
# own manifest, this predicate has drifted and every other number here is suspect.
PAIRS = [("SODTL", "SO"), ("PODTL", "PO"), ("GRDTL", "GR"),
         ("DODTL", "DO"), ("IVDTL", "IV"), ("PIDTL", "PI")]

# The EXACT predicate export-ac-line-photos.py uses. It is duplicated rather
# than imported because that script opens a connection and runs an extraction
# at import time; the string is short, and a drift between the two is caught by
# the SO/PO control rows above.
PICT = "FurtherDescription IS NOT NULL AND FurtherDescription LIKE '%{\pict%'"


def connect():
    if not CRED or not os.path.exists(CRED):
        sys.exit("AC_CRED_FILE must point at a file holding only the DB password")
    pwd = open(CRED).read().strip()
    cn = pyodbc.connect(
        "DRIVER={SQL Server Native Client 11.0};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
        % (HOST, DB, USER, pwd), timeout=30)
    del pwd
    cn.cursor().execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 5000;")
    return cn


def per_document(cur):
    """Picture lines on named book documents — the tally's open list, usually."""
    for dtl, hdr in PAIRS:
        ph = ",".join("?" * len(DOCS))
        cur.execute(
            "SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo, COUNT(*) AS lines_tot, "
            "SUM(CASE WHEN d.FurtherDescription LIKE '%%{\pict%%' THEN 1 ELSE 0 END) AS pict "
            "FROM %s h WITH (NOLOCK) JOIN %s d WITH (NOLOCK) ON d.DocKey = h.DocKey "
            "WHERE LTRIM(RTRIM(h.DocNo)) IN (%s) "
            "GROUP BY LTRIM(RTRIM(h.DocNo)) ORDER BY 1" % (hdr, dtl, ph), *DOCS)
        for r in cur.fetchall():
            print("  %-6s %-16s %d of %d line(s) carry a drawing" % (dtl, r.DocNo, r.pict, r.lines_tot))


def whole_table(cur):
    print("%-6s %10s %14s %12s   %s" % ("table", "lines", "rich text", "DRAWINGS", "elapsed"))
    for dtl, hdr in PAIRS:
        cur.execute("SELECT COUNT(*), MIN(DtlKey), MAX(DtlKey) FROM %s WITH (NOLOCK)" % dtl)
        n, lo, hi = cur.fetchone()
        cur.execute("SELECT COUNT(*) FROM %s WITH (NOLOCK) "
                    "WHERE FurtherDescription IS NOT NULL AND DATALENGTH(FurtherDescription) > 0" % dtl)
        rich = cur.fetchone()[0]
        t0, total, k = time.time(), 0, (lo or 0) - 1
        while k < (hi or 0):
            top = k + WIN
            cur.execute("SELECT COUNT(*) FROM %s WITH (NOLOCK) WHERE DtlKey > ? AND DtlKey <= ? AND %s"
                        % (dtl, PICT), k, top)
            total += cur.fetchone()[0]
            k = top
        print("%-6s %10d %14d %12d   %.1fs%s"
              % (dtl, n, rich, total, time.time() - t0,
                 "   <- exporter already covers this" if dtl in ("SODTL", "PODTL") else ""))
        sys.stdout.flush()


def main():
    cn = connect()
    cur = cn.cursor()
    print("book=%s@%s  (READ UNCOMMITTED, no locks taken, RTF body never selected)" % (DB, HOST))
    if DOCS:
        per_document(cur)
    else:
        whole_table(cur)
    cn.close()


if __name__ == "__main__":
    main()
