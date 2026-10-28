#!/usr/bin/env python
"""Export AutoCount's PER-LINE truth for every migrated document type, so
check-migration-fidelity.mjs can compare the ERP field by field.

WHY THIS FILE EXISTS AT ALL. The cutover's own exports were written per
QUESTION, and one of them aggregated. export-received-pos-live.py filled the
`GrQty` column with

    (SELECT COALESCE(SUM(g.Qty),0) FROM GRDTL g JOIN GR gh ON gh.DocKey=g.DocKey
      WHERE g.FromDocNo = h.DocNo AND gh.Cancelled='F' AND g.ItemCode = d.ItemCode)

which is keyed on (DocNo, ItemCode) and NOT on the detail row. Every same-code
line on one purchase order therefore received the DOCUMENT's total, and
import-ac-so-linked-pos.mjs wrote that number straight into
purchase_order_items.received_qty. PO-009633 carries HOK-1005 (Q) twice, each
ordered 1 and each received 1; both ERP lines read "received 2".

So the rule for everything in this file: ONE ROW PER AutoCount DETAIL KEY, and
every quantity read from the detail row's own column. No SUM, no GROUP BY on a
document, no correlated subquery keyed on anything coarser than DtlKey. The one
aggregate that is exported (ac-fidelity-gr-by-po-line) is labelled as an
aggregate and exists only so the check can SHOW the trap, never to stand in for
a per-line value.

STRICTLY READ-ONLY. SELECT only - no INSERT/UPDATE/DELETE, no DDL, no temp
tables. AutoCount is the floor's live system.

Run from the office network (the AutoCount host is only reachable over
ZeroTier). A CI runner is NOT on that network, which is why the ERP-side check
reads the committed snapshot rather than querying AutoCount itself - the same
split export-ac-live.py + check-stock-vs-autocount.mjs already use.

  AC_HOST      default 10.147.17.100,55500
  AC_DB        default AED_HOUZS
  AC_USER      default sa2
  AC_CRED_FILE path to a file containing ONLY the password. Required.
               The credential is never printed and never written to the repo.

  python backend/scripts/export-ac-fidelity-truth.py
"""
import json, gzip, os, sys, datetime, decimal

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

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DRIVER = os.environ.get("AC_DRIVER", "SQL Server Native Client 11.0")

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s;TrustServerCertificate=yes"
    % (DRIVER, HOST, DB, USER, open(CRED, encoding="utf-8-sig").read().strip()), timeout=180)
cn.timeout = 600
cur = cn.cursor()
stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def rows(sql):
    cur.execute(sql)
    cols = [c[0] for c in cur.description]
    out = []
    for r in cur.fetchall():
        d = {}
        for c, v in zip(cols, r):
            if isinstance(v, (datetime.datetime, datetime.date)):
                v = v.strftime("%Y-%m-%d")
            elif isinstance(v, decimal.Decimal):
                v = float(v)
            elif isinstance(v, (bytes, bytearray)):
                v = None
            elif isinstance(v, str):
                v = v.strip()
            d[c] = v
        out.append(d)
    return out


def dump(name, obj):
    p = os.path.join(OUT, name)
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    print("  wrote {:40s} {:7d} rows {:>9d} bytes".format(name, len(obj), os.path.getsize(p)))


# ---------------------------------------------------------------- sales orders
# Every non-cancelled SO, not only the outstanding ones: scoping the TRUTH by a
# re-derived predicate would let a document the ERP holds fall outside the
# snapshot and read as "no AutoCount match", which is indistinguishable from a
# real gap. The check reports its own coverage instead.
so_headers = rows("""
SELECT LTRIM(RTRIM(h.DocNo)) DocNo, CONVERT(varchar(10), h.DocDate, 120) DocDate,
       ISNULL(LTRIM(RTRIM(h.DebtorCode)),'') DebtorCode, ISNULL(LTRIM(RTRIM(h.DebtorName)),'') DebtorName,
       ISNULL(LTRIM(RTRIM(h.SalesAgent)),'') SalesAgent, ISNULL(LTRIM(RTRIM(h.SalesLocation)),'') SalesLocation,
       ISNULL(LTRIM(RTRIM(h.Ref)),'') Ref, ISNULL(LTRIM(RTRIM(h.Phone1)),'') Phone1,
       ISNULL(LTRIM(RTRIM(h.DeliverPhone1)),'') DeliverPhone1,
       ISNULL(LTRIM(RTRIM(h.InvAddr1)),'') InvAddr1, ISNULL(LTRIM(RTRIM(h.InvAddr2)),'') InvAddr2,
       ISNULL(LTRIM(RTRIM(h.InvAddr3)),'') InvAddr3, ISNULL(LTRIM(RTRIM(h.InvAddr4)),'') InvAddr4,
       ISNULL(LTRIM(RTRIM(h.UDF_VENUE)),'') UDF_VENUE, ISNULL(LTRIM(RTRIM(h.UDF_BRANDING)),'') UDF_BRANDING,
       ISNULL(h.UDF_BALANCE, 0) UDF_BALANCE, CONVERT(varchar(10), h.UDF_PDate, 120) UDF_PDate,
       h.Cancelled
FROM SO h""")
print("SO headers:", len(so_headers))

# ONE ROW PER SODTL.DtlKey. Qty/TransferedQty/UnitPrice are the detail row's own
# columns - never summed to the document.
so_lines = rows("""
SELECT LTRIM(RTRIM(h.DocNo)) DocNo, d.DtlKey, d.Seq,
       ISNULL(LTRIM(RTRIM(d.ItemCode)),'') ItemCode, ISNULL(LTRIM(RTRIM(d.Description)),'') Description,
       ISNULL(LTRIM(RTRIM(d.Desc2)),'') Desc2, ISNULL(LTRIM(RTRIM(d.Location)),'') Location,
       ISNULL(d.Qty,0) Qty, ISNULL(d.TransferedQty,0) TransferedQty,
       ISNULL(d.TransferedPOQty,0) TransferedPOQty, ISNULL(d.UnitPrice,0) UnitPrice,
       ISNULL(LTRIM(RTRIM(d.UOM)),'') UOM,
       CONVERT(varchar(10), d.DeliveryDate, 120) DeliveryDate
FROM SODTL d JOIN SO h ON h.DocKey = d.DocKey
WHERE h.Cancelled = 'F'""")
print("SO lines:", len(so_lines))

# ------------------------------------------------------------- purchase orders
po_headers = rows("""
SELECT LTRIM(RTRIM(h.DocNo)) DocNo, CONVERT(varchar(10), h.DocDate, 120) DocDate,
       ISNULL(LTRIM(RTRIM(h.CreditorCode)),'') CreditorCode, ISNULL(LTRIM(RTRIM(h.CreditorName)),'') CreditorName,
       ISNULL(LTRIM(RTRIM(h.Ref)),'') Ref, ISNULL(LTRIM(RTRIM(h.PurchaseLocation)),'') PurchaseLocation,
       ISNULL(h.NetTotal,0) NetTotal, h.Cancelled
FROM PO h""")
print("PO headers:", len(po_headers))

# ONE ROW PER PODTL.DtlKey. TransferedQty IS AutoCount's per-line received
# quantity - the field the cutover replaced with a document-level SUM.
po_lines = rows("""
SELECT LTRIM(RTRIM(h.DocNo)) DocNo, d.DtlKey, d.Seq,
       ISNULL(LTRIM(RTRIM(d.ItemCode)),'') ItemCode, ISNULL(LTRIM(RTRIM(d.Description)),'') Description,
       ISNULL(LTRIM(RTRIM(d.Desc2)),'') Desc2, ISNULL(LTRIM(RTRIM(d.Location)),'') Location,
       ISNULL(d.Qty,0) Qty, ISNULL(d.TransferedQty,0) TransferedQty, ISNULL(d.UnitPrice,0) UnitPrice,
       ISNULL(LTRIM(RTRIM(d.UOM)),'') UOM,
       CONVERT(varchar(10), d.DeliveryDate, 120) DeliveryDate,
       ISNULL(d.FromSODtlKey,0) FromSODtlKey, ISNULL(LTRIM(RTRIM(d.FromSODocList)),'') FromSODocList
FROM PODTL d JOIN PO h ON h.DocKey = d.DocKey
WHERE h.Cancelled = 'F'""")
print("PO lines:", len(po_lines))

# ------------------------------------------------------------- delivery orders
do_headers = rows("""
SELECT LTRIM(RTRIM(h.DocNo)) DocNo, CONVERT(varchar(10), h.DocDate, 120) DocDate,
       ISNULL(LTRIM(RTRIM(h.DebtorCode)),'') DebtorCode, ISNULL(LTRIM(RTRIM(h.DebtorName)),'') DebtorName,
       ISNULL(LTRIM(RTRIM(h.SalesLocation)),'') SalesLocation, h.Cancelled
FROM DO h WHERE h.Cancelled = 'F'""")
print("DO headers:", len(do_headers))

do_lines = rows("""
SELECT LTRIM(RTRIM(h.DocNo)) DocNo, d.DtlKey, d.Seq,
       ISNULL(LTRIM(RTRIM(d.ItemCode)),'') ItemCode, ISNULL(LTRIM(RTRIM(d.Description)),'') Description,
       ISNULL(LTRIM(RTRIM(d.Desc2)),'') Desc2, ISNULL(LTRIM(RTRIM(d.Location)),'') Location,
       ISNULL(d.Qty,0) Qty, ISNULL(d.UnitPrice,0) UnitPrice,
       ISNULL(LTRIM(RTRIM(d.FromDocType)),'') FromDocType, ISNULL(LTRIM(RTRIM(d.FromDocNo)),'') FromDocNo
FROM DODTL d JOIN DO h ON h.DocKey = d.DocKey
WHERE h.Cancelled = 'F'""")
print("DO lines:", len(do_lines))

# ------------------------------------------------------------- goods receipts
# THIS ONE IS AN AGGREGATE AND IS LABELLED AS SUCH. It reproduces exactly the
# (PoNo, ItemCode) grouping that produced the received_qty defect, so the check
# can put the wrong number and the right one side by side and name the cause.
# It is never used as a per-line expectation - PODTL.TransferedQty is.
gr_by_po_item = rows("""
SELECT LTRIM(RTRIM(g.FromDocNo)) PoNo, ISNULL(LTRIM(RTRIM(g.ItemCode)),'') ItemCode,
       SUM(ISNULL(g.Qty,0)) GrQtySum, COUNT(*) GrLines
FROM GRDTL g JOIN GR gh ON gh.DocKey = g.DocKey
WHERE gh.Cancelled = 'F' AND g.FromDocNo IS NOT NULL AND LTRIM(RTRIM(g.FromDocNo)) <> ''
GROUP BY LTRIM(RTRIM(g.FromDocNo)), LTRIM(RTRIM(g.ItemCode))""")
print("GR aggregate cells (PoNo,ItemCode):", len(gr_by_po_item))

# ------------------------------------------------------------------- manifest
# FromDocDtlKey is 0 on every GR and PI detail row in this book, so a GR line
# cannot be traced to the PO line it received. Measured, not assumed, because
# the whole join strategy depends on it.
[(grdtl_n, grdtl_keyed)] = [tuple(r.values()) for r in rows(
    "SELECT COUNT(*) n, SUM(CASE WHEN ISNULL(FromDocDtlKey,0) <> 0 THEN 1 ELSE 0 END) keyed FROM GRDTL")]

dump("ac-fidelity-so-headers.json.gz", so_headers)
dump("ac-fidelity-so-lines.json.gz", so_lines)
dump("ac-fidelity-po-headers.json.gz", po_headers)
dump("ac-fidelity-po-lines.json.gz", po_lines)
dump("ac-fidelity-do-headers.json.gz", do_headers)
dump("ac-fidelity-do-lines.json.gz", do_lines)
dump("ac-fidelity-gr-by-po-item.json.gz", gr_by_po_item)

manifest = {
    "exported_at": stamp,
    "source": "AED_HOUZS live (read-only)",
    "grain": "one row per AutoCount DtlKey; no aggregation except ac-fidelity-gr-by-po-item",
    "counts": {
        "so_headers": len(so_headers), "so_lines": len(so_lines),
        "po_headers": len(po_headers), "po_lines": len(po_lines),
        "do_headers": len(do_headers), "do_lines": len(do_lines),
        "gr_by_po_item": len(gr_by_po_item),
    },
    "grdtl_rows": int(grdtl_n),
    "grdtl_rows_with_line_key": int(grdtl_keyed or 0),
}
json.dump(manifest, open(os.path.join(OUT, "ac-fidelity-manifest.json"), "w"), indent=2)
print("manifest written; exported_at", stamp)
print("GRDTL rows with a usable FromDocDtlKey: %d of %d" % (int(grdtl_keyed or 0), int(grdtl_n)))
