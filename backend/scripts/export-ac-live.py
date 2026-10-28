#!/usr/bin/env python
"""Export the LIVE AutoCount book (AED_HOUZS) into the snapshot files that
check-stock-vs-autocount.mjs compares against.

STRICTLY READ-ONLY. SELECT only — no INSERT/UPDATE/DELETE, no DDL. AutoCount is
the floor's live system and staff are still working in it; the owner's standing
rule is that the ERP is the only editing surface.

Run from the office network (the AutoCount host is only reachable over
ZeroTier). A CI runner is NOT on that network, which is why the ERP-side check
reads committed snapshot files rather than querying AutoCount itself.

  AC_HOST      default 10.147.17.100,55500
  AC_DB        default AED_HOUZS
  AC_USER      default sa2
  AC_CRED_FILE path to a file containing ONLY the password. Required.
               The credential is never printed and never written to the repo.

  python backend/scripts/export-ac-live.py
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
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=180)
cur = cn.cursor()
stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def dump(name, obj):
    p = os.path.join(OUT, name)
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(obj, f)
    print("  wrote {:38s} {:6d} rows  {:>8d} bytes".format(name, len(obj), os.path.getsize(p)))


# 1. On-hand per item+location. Summed over UOM rows: three item+location cells
#    carry two UOM rows each, and every ItemUOM rate in this book is 1, so the
#    sum is the unit count with no conversion involved.
cur.execute("""SELECT LTRIM(RTRIM(ItemCode)) ItemCode, LTRIM(RTRIM(ISNULL(Location,''))) Location,
   SUM(BalQty) BalQty FROM vItemBalQty GROUP BY LTRIM(RTRIM(ItemCode)), LTRIM(RTRIM(ISNULL(Location,'')))""")
bal = [{"ItemCode": a, "Location": b, "BalQty": float(c or 0)} for a, b, c in cur.fetchall()]
print("live balance cells:", len(bal), "| non-zero:", sum(1 for r in bal if r["BalQty"]))

# 2. Remark2 — the operator's stock-status column — for every non-cancelled SO,
#    with the outstanding flag so the comparison can be scoped to open orders.
cur.execute("""SELECT LTRIM(RTRIM(h.DocNo)) DocNo, LTRIM(RTRIM(ISNULL(h.Remark2,''))) Remark2,
   CASE WHEN EXISTS (SELECT 1 FROM SODTL d WHERE d.DocKey=h.DocKey AND (d.Qty-ISNULL(d.TransferedQty,0))>0)
        THEN 1 ELSE 0 END AS Outstanding
 FROM SO h WHERE h.Cancelled='F'""")
rem = [{"DocNo": a, "Remark2": b, "Outstanding": int(c)} for a, b, c in cur.fetchall()]
print("SO remark2 rows:", len(rem), "| outstanding:", sum(r["Outstanding"] for r in rem))

# 3. Item master — ItemGroup separates real stock from the service pseudo-items
#    (DISPOSE / TRANSPORTATION CHARGES / STORAGE) that AutoCount stock-controls.
cur.execute("""SELECT LTRIM(RTRIM(ItemCode)) ItemCode, LTRIM(RTRIM(ISNULL(ItemGroup,''))) ItemGroup,
   LTRIM(RTRIM(ISNULL(ItemType,''))) ItemType, LTRIM(RTRIM(ISNULL(ItemCategory,''))) ItemCategory,
   ISNULL(StockControl,0) StockControl, ISNULL(IsActive,0) IsActive, ISNULL(Discontinued,0) Discontinued
 FROM Item""")
items = [{"ItemCode": a, "ItemGroup": b, "ItemType": c, "ItemCategory": d,
          "StockControl": int(bool(e)), "IsActive": int(bool(f)), "Discontinued": int(bool(g))}
         for a, b, c, d, e, f, g in cur.fetchall()]
print("item master rows:", len(items), "| stock-controlled:", sum(i["StockControl"] for i in items))

# 4. Stock activity dated on/after the cutover snapshot — this is what makes the
#    two systems legitimately diverge, so it is measured rather than assumed.
post = {}
for t in ("DO", "GR", "IV", "ADJ", "CS", "CP", "SA", "PI", "ISS", "GT", "STOCKXFER", "CN", "DN"):
    try:
        cur.execute("SELECT COUNT(*), MAX(DocDate) FROM %s WHERE Cancelled='F' AND DocDate >= '2026-08-09'" % t)
        n, mx = cur.fetchone()
        post[t] = {"docs": int(n), "latest": str(mx)[:10] if mx else None}
    except Exception as ex:
        post[t] = {"error": str(ex)[:80]}
print("post-cutoff doc activity:", json.dumps({k: v for k, v in post.items() if v.get("docs")}))

dump("ac-live-stock-balance.json.gz", bal)
dump("ac-live-so-remark2.json.gz", rem)
dump("ac-live-item-master.json.gz", items)
json.dump({"exported_at": stamp, "source": "AED_HOUZS live (read-only)",
           "post_cutoff_activity": post, "balance_cells": len(bal),
           "so_rows": len(rem), "items": len(items)},
          open(os.path.join(OUT, "ac-live-export-manifest.json"), "w"), indent=2)
print("manifest written; exported_at", stamp)
