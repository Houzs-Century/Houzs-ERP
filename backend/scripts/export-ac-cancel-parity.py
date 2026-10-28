#!/usr/bin/env python
"""Export the AutoCount half of the CANCEL PARITY check.

WHY THIS FILE EXISTS. The owner's third go-live rule is that a cancel must not
diverge: "cancel 了一边，另一边还开着" splits the outstanding set, and his
acceptance test is that his own outstanding rule — NOT converted to DO and NOT
to IV, cancelled excluded — computes IDENTICALLY on both sides. Testing that
needs AutoCount's answer and the ERP's answer at the same time, and no single
machine can reach both: the account book sits behind ZeroTier on the shop's
network, the production database is reachable only from a GitHub runner. So the
AutoCount half is exported HERE, on a machine that is on that network, committed
as a snapshot, and check-cancel-parity.mjs compares it against production.

STRICTLY READ-ONLY. SELECT only — no INSERT/UPDATE/DELETE, no DDL, no stored
procedure. The owner's standing rule is that the ERP is the only editing surface
and staff are working in this book right now.

  AC_HOST      default 10.147.17.100,55500
  AC_DB        default AED_HOUZS
  AC_USER      default sa2
  AC_CRED_FILE path to a file containing ONLY the password. Required.
               Never printed, never written to the repo.

  AC_CRED_FILE=<path> python backend/scripts/export-ac-cancel-parity.py

WHAT THE OUTSTANDING FLAG MEANS, precisely, because the whole check rests on it.
AutoCount records how much of an SO line has moved downstream in
SODTL.TransferedQty, and it counts a transfer to a Delivery Order and a direct
transfer to an Invoice alike. So "not converted to DO and not to IV" is one
predicate, not two:

    Cancelled = 'F'  AND  EXISTS (a line with Qty - TransferedQty > 0)

Measured against the live book on 2026-08-11 that is 2,712 of 13,010 live SOs;
10,298 are fully transferred and 5 are cancelled. HasDo / HasIv are exported
alongside it — not as part of the rule, but so a disagreement can be READ: an
order flagged outstanding that already has a partial DO (52 of them) fails for a
different reason than one with nothing behind it at all.
"""
import json, gzip, os, sys, datetime

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is required: pip install pyodbc")

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB   = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
if not CRED or not os.path.exists(CRED):
    sys.exit("set AC_CRED_FILE to a file containing the AutoCount password")

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DRIVER = os.environ.get("AC_DRIVER", "SQL Server Native Client 11.0")

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=300)
cur = cn.cursor()
stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

# ── Sales Orders: the owner's rule, per document ────────────────────────────
# Cancelled is CHAR(1) 'T'/'F' on every AutoCount header, not a bit.
cur.execute("""
SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo,
       CASE WHEN h.Cancelled='T' THEN 1 ELSE 0 END AS Cancelled,
       CASE WHEN EXISTS (SELECT 1 FROM SODTL d
                          WHERE d.DocKey=h.DocKey
                            AND (d.Qty - ISNULL(d.TransferedQty,0)) > 0)
            THEN 1 ELSE 0 END AS Outstanding,
       CASE WHEN EXISTS (SELECT 1 FROM DODTL x
                          WHERE x.FromDocType='SO' AND LTRIM(RTRIM(x.FromDocNo))=LTRIM(RTRIM(h.DocNo)))
            THEN 1 ELSE 0 END AS HasDo,
       CASE WHEN EXISTS (SELECT 1 FROM IVDTL x
                          WHERE x.FromDocType='SO' AND LTRIM(RTRIM(x.FromDocNo))=LTRIM(RTRIM(h.DocNo)))
            THEN 1 ELSE 0 END AS HasIv
FROM SO h""")
so = [[a, int(b), int(c), int(d), int(e)] for a, b, c, d, e in cur.fetchall()]
print("SO headers: {:d} | cancelled: {:d} | outstanding: {:d}".format(
    len(so), sum(r[1] for r in so), sum(1 for r in so if not r[1] and r[2])))

# ── The other five document types: existence + cancelled, nothing more ──────
# This half answers only "does AutoCount still hold this document open?", which
# is all the cancel-parity comparison needs. Exported as [DocNo, Cancelled]
# pairs rather than objects to keep the snapshot small — there are ~40,000 of
# them and the field names would be three quarters of the bytes.
DOCS = {}
for t in ("PO", "DO", "GR", "IV", "PI"):
    cur.execute("SELECT LTRIM(RTRIM(DocNo)), CASE WHEN Cancelled='T' THEN 1 ELSE 0 END FROM " + t)
    rows = [[a, int(b)] for a, b in cur.fetchall()]
    DOCS[t] = rows
    print("{} headers: {:d} | cancelled: {:d}".format(t, len(rows), sum(r[1] for r in rows)))

payload = {
    "exported_at": stamp,
    "book": DB,
    # Column order is part of the contract with check-cancel-parity.mjs.
    "so_cols": ["DocNo", "Cancelled", "Outstanding", "HasDo", "HasIv"],
    "so": so,
    "doc_cols": ["DocNo", "Cancelled"],
    "docs": DOCS,
}
p = os.path.join(OUT, "ac-cancel-parity.json.gz")
with gzip.open(p, "wt", encoding="utf-8") as f:
    json.dump(payload, f)
print("wrote {}  {:d} bytes".format(p, os.path.getsize(p)))
