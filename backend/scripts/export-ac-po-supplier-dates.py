"""Export AutoCount's supplier delivery dates for every purchase order that has one.

WHY THIS FILE EXISTS. AutoCount's PO chasing list shows three supplier dates
that the ERP never received (owner, 2026-09-15). The CI runner cannot reach
AutoCount (it is only on ZeroTier), so the ERP-side fill tool
`fill-po-supplier-dates-from-autocount.mjs` reads this committed snapshot instead
of querying the book itself.

THE FIELDS, as established read-only against AED_HOUZS on 2026-09-15. They are
HEADER UDFs, not line fields; the chasing report repeats them on every line:

  report column              AutoCount column  UDF caption                  ERP column
  Estimate Delivery Date     PO.UDF_EDate      "Supplier Delivery Date"     supplier_delivery_date_2
  Supplier Delivery Date 2   PO.UDF_EDate2     "Supplier Delivery Date 2"   supplier_delivery_date_3
  Supplier Delivery Date 3   PO.UDF_EDate3     "Supplier Delivery Date 3"   supplier_delivery_date_4
  Delivery Date              PODTL.DeliveryDate                             purchase_order_items.delivery_date

The ERP's slot 1 is the base date (delivery_date / expected_at) and 2/3/4 are
the supplier's dates after it, so AutoCount's three supplier dates go into
2/3/4. PODTL.EstimatedDeliveryDate is a different, free-text field (3 rows, 2024).

READ-ONLY: SELECTs only, no writes, no DDL, no transaction.

RE-RUN: overwrites `data/ac-po-supplier-dates.json.gz` and stamps
`data/ac-po-supplier-dates-manifest.json` with the export time. Safe to run as
often as you like; it is the input refresh, not a repair.

Env: AC_CRED_FILE (required, a file holding the sa2 password - never printed),
AC_HOST / AC_DB / AC_USER / AC_DRIVER as for export-ac-live.py.
"""
import gzip
import json
import os
import sys
from datetime import datetime

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is required: pip install pyodbc")

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
DRIVER = os.environ.get("AC_DRIVER", "SQL Server Native Client 11.0")
if not CRED or not os.path.exists(CRED):
    sys.exit("set AC_CRED_FILE to a file containing the AutoCount password")

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=180)
cur = cn.cursor()
stamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def d(v):
    return v.strftime("%Y-%m-%d") if v else None


cur.execute("""
SELECT h.DocKey, LTRIM(RTRIM(h.DocNo)), h.DocDate, h.Cancelled, h.LastModified,
       h.UDF_EDate, h.UDF_EDate2, h.UDF_EDate3
  FROM PO h
 WHERE h.UDF_EDate IS NOT NULL OR h.UDF_EDate2 IS NOT NULL OR h.UDF_EDate3 IS NOT NULL
""")
heads = {}
for k, doc, dd, canc, lm, e1, e2, e3 in cur.fetchall():
    heads[k] = {
        "DocNo": doc, "DocDate": d(dd), "Cancelled": (canc or "").strip() == "T",
        "LastModified": lm.strftime("%Y-%m-%dT%H:%M:%S") if lm else None,
        "EDate": d(e1), "EDate2": d(e2), "EDate3": d(e3), "Lines": [],
    }

cur.execute("""
SELECT d.DocKey, d.DtlKey, LTRIM(RTRIM(ISNULL(d.ItemCode,''))), d.Qty, ISNULL(d.TransferedQty,0), d.DeliveryDate
  FROM PODTL d JOIN PO h ON h.DocKey = d.DocKey
 WHERE h.UDF_EDate IS NOT NULL OR h.UDF_EDate2 IS NOT NULL OR h.UDF_EDate3 IS NOT NULL
""")
for k, dtl, item, qty, tq, ddate in cur.fetchall():
    heads[k]["Lines"].append({
        "DtlKey": int(dtl), "ItemCode": item, "Qty": float(qty or 0),
        "TransferedQty": float(tq or 0), "DeliveryDate": d(ddate),
    })

rows = sorted(heads.values(), key=lambda r: r["DocNo"])
for r in rows:
    r["Outstanding"] = (not r["Cancelled"]) and any(l["Qty"] > l["TransferedQty"] for l in r["Lines"])

os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, "ac-po-supplier-dates.json.gz")
with gzip.open(path, "wt", encoding="utf-8") as f:
    json.dump(rows, f)
manifest = {
    "exported_at": stamp, "source": "%s / %s" % (HOST.split(",")[0], DB),
    "purchase_orders": len(rows),
    "with_EDate": sum(1 for r in rows if r["EDate"]),
    "with_EDate2": sum(1 for r in rows if r["EDate2"]),
    "with_EDate3": sum(1 for r in rows if r["EDate3"]),
    "outstanding": sum(1 for r in rows if r["Outstanding"]),
}
with open(os.path.join(OUT, "ac-po-supplier-dates-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest))
