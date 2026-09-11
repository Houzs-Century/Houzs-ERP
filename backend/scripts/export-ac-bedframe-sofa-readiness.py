"""Export AutoCount's OWN per-line readiness evidence for bedframe + sofa.

WHY THIS FILE EXISTS. `check-bedframe-sofa-status-truth.mjs` consumes
`data/ac-bedframe-sofa-readiness.json.gz` and there was no committed producer
for it — the snapshot in the tree was taken ad hoc on 2026-09-09, and on
2026-09-11 the owner asked for the comparison against LIVE AutoCount rather than
a two-day-old file. A check whose input can only be refreshed by somebody
remembering how is a check that will be run against a stale input.

WHAT "READY" MEANS IN AUTOCOUNT, and it is not a field. Established read-only
against AED_HOUZS and recorded in the consumer's header: `SODTL.StockReceived`,
`PurchaseStatus` and `DeliveryStatus` are dead on every open line. The human
signal is `SO.Remark2`, free text — but typed to one exact rule: every line on a
READY-ish Remark2 order is bound (`SODTL.UDF_PONo` / `TransferedPOQty > 0`) AND
that bound PO has a goods receipt. So AutoCount READY(line) == the PO raised
from that line by Convert-to-PO has been received, which is the same rule the
ERP runs in BOUND mode. This export carries the EVIDENCE (the bound PO and its
GR quantity), not a verdict, so the comparison can state which side is wrong.

READ-ONLY: SELECTs only, no writes, no DDL, no transaction.

RE-RUN: overwrites `data/ac-bedframe-sofa-readiness.json.gz` and stamps
`data/ac-bedframe-sofa-readiness-manifest.json` with the export time. Safe to
run as often as you like; it is the input refresh, not a repair.

Env: AC_CRED_FILE (required, a file holding the sa2 password — never printed),
AC_HOST / AC_DB / AC_USER / AC_DRIVER as for export-ac-live.py.
"""
import gzip
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is required: pip install pyodbc")

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
if not CRED or not os.path.exists(CRED):
    sys.exit("set AC_CRED_FILE to a file containing the AutoCount password")
DRIVER = os.environ.get("AC_DRIVER", "SQL Server Native Client 11.0")

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT, exist_ok=True)

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=180)
cur = cn.cursor()

# OUTSTANDING lines only (Qty > TransferedQty) — a fully delivered line has no
# readiness question left. ItemGroup comes from the item master; the two groups
# the owner's bound rule covers are the only ones exported.
SQL = """
SELECT  so.DocNo, so.DocDate, so.Remark2,
        d.DtlKey, d.ItemCode, d.Desc2, d.Location,
        i.ItemGroup,
        d.Qty, d.TransferedQty,
        (d.Qty - ISNULL(d.TransferedQty, 0))      AS Need,
        ISNULL(d.TransferedPOQty, 0)              AS TransferedPOQty,
        ISNULL(d.UDF_PONo, '')                    AS BoundPo,
        d.DeliveryDate, d.EstimatedDeliveryDate,
        ISNULL(gr.GrQty, 0)                       AS BoundPoGrQty,
        CASE WHEN ISNULL(gr.GrQty, 0) > 0 THEN 1 ELSE 0 END AS BoundPoReceived
FROM    SODTL d
JOIN    SO   so ON so.DocKey = d.DocKey
LEFT JOIN Item i ON i.ItemCode = d.ItemCode
OUTER APPLY (
        SELECT SUM(g.Qty) AS GrQty
        FROM   GRDTL g
        WHERE  g.FromDocNo = d.UDF_PONo
          AND  g.ItemCode  = d.ItemCode
) gr
WHERE   i.ItemGroup IN ('BEDFRAME', 'SOFA')
  AND   d.Qty > ISNULL(d.TransferedQty, 0)
"""


def jsonable(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        # AutoCount quantities are SQL decimals; keep them numbers, and keep an
        # integral one integral so the JSON reads like the snapshot it replaces.
        f = float(v)
        return int(f) if f == int(f) else f
    return v


cur.execute(SQL)
cols = [c[0] for c in cur.description]
rows = [{c: jsonable(v) for c, v in zip(cols, r)} for r in cur.fetchall()]

by_group = {}
bound = 0
received = 0
for r in rows:
    by_group[r["ItemGroup"]] = by_group.get(r["ItemGroup"], 0) + 1
    if r["BoundPo"]:
        bound += 1
    if r["BoundPoReceived"]:
        received += 1

path = os.path.join(OUT, "ac-bedframe-sofa-readiness.json.gz")
with gzip.open(path, "wt", encoding="utf-8") as f:
    json.dump(rows, f)

stamp = datetime.now().isoformat(timespec="seconds")
with open(os.path.join(OUT, "ac-bedframe-sofa-readiness-manifest.json"), "w") as f:
    json.dump({
        "exported_at": stamp,
        "source": "%s live (read-only)" % DB,
        "rows": len(rows),
        "by_group": by_group,
        "bound_lines": bound,
        "bound_po_received_lines": received,
    }, f, indent=2)

print("rows: %d  %s" % (len(rows), json.dumps(by_group)))
print("bound to a PO: %d | that PO received: %d" % (bound, received))
print("wrote %s (%d bytes); exported_at %s" % (path, os.path.getsize(path), stamp))
cn.close()
