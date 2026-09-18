#!/usr/bin/env python
"""Export AutoCount's DETAIL LISTING values for Goods Received (GR), Purchase
Invoice (PI) and Sales Invoice (IV) lines, so check-ac-listing-parity.mjs can
measure, column by column, how many ERP line-export values equal what
AutoCount's own Detail Listing shows for the same line.

WHY. Owner 2026-09-15: every transaction list's Excel export must be 100%
AutoCount's listing format - the same column labels and the same values. The
labels are read from the company's saved listing layouts (scm Layout table,
FormGoodsReceivedNotePrintDetailListing / FormPurchaseInvoicePrintDetailListing
/ FormInvoicePrintDetailListing); the VALUES are these rows.

ONE ROW PER AutoCount DETAIL KEY (DtlKey), every value read from that detail
row or its own header - no SUM, no GROUP BY (the trap export-ac-fidelity-truth.py
records).

PRIVACY. The repository is public. A debtor (customer) name is exported as a
SHA-256 of its trimmed, upper-cased text, which is enough to count matches and
reveals nothing. Creditor (supplier) names are businesses and are kept.

STRICTLY READ-ONLY. SELECT only - no INSERT/UPDATE/DELETE, no DDL, no temp
tables. AutoCount is the floor's live system.

  AC_HOST      default 10.147.17.100,55500
  AC_DB        default AED_HOUZS
  AC_USER      default sa2
  AC_CRED_FILE path to a file containing ONLY the password. Required.
               The credential is never printed and never written to the repo.
  AC_SINCE     documents dated on or after this day (default 2026-01-01)

  python backend/scripts/export-ac-listing-lines.py
"""
import json, gzip, os, sys, datetime, decimal, hashlib

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is required: pip install pyodbc")

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
SINCE = os.environ.get("AC_SINCE", "2026-01-01")
if not CRED or not os.path.exists(CRED):
    sys.exit("set AC_CRED_FILE to a file containing the AutoCount password")
DRIVER = os.environ.get("AC_DRIVER", "SQL Server Native Client 11.0")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=180)
cur = cn.cursor()


def val(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str):
        return v.strip()
    return v


def sha(v):
    s = (v or "").strip().upper()
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16] if s else None


# The header columns each listing shows, per document type. SupplierDONo is the
# GR's "Supplier DO No", SupplierInvoiceNo the PI's; IV carries Ref instead.
SPECS = {
    "GR": ("GR", "GRDTL", "h.CreditorCode PartyCode, h.CreditorName PartyName, h.PurchaseAgent Agent, h.SupplierDONo DocRef, d.OurPONo LinkNo"),
    "PI": ("PI", "PIDTL", "h.CreditorCode PartyCode, h.CreditorName PartyName, h.PurchaseAgent Agent, h.SupplierInvoiceNo DocRef, d.OurPONo LinkNo"),
    "IV": ("IV", "IVDTL", "h.DebtorCode PartyCode, h.DebtorName PartyName, h.SalesAgent Agent, h.Ref DocRef, d.YourPONo LinkNo"),
}

rows = []
for t, (H, D, party) in SPECS.items():
    cur.execute(f"""
      SELECT '{t}' T, d.DtlKey, d.DocKey, d.Seq, h.DocNo, h.DocDate, {party},
             h.CurrencyCode, h.CurrencyRate, h.InclusiveTax, h.TotalExTax, h.Tax, h.NetTotal, h.LocalNetTotal, h.Cancelled,
             d.ItemCode, d.Description, d.Desc2, d.UDF_Desc2, d.UOM, d.Location, d.ProjNo, d.Qty, d.UnitPrice,
             d.Discount, d.DiscountAmt, d.SubTotal, d.TaxCode, d.Tax DtlTax, d.SubTotalExTax, d.DeliveryDate,
             i.ItemGroup, i.Description ItemMasterDesc, i.BaseUOM ItemBaseUOM
      FROM {D} d JOIN {H} h ON h.DocKey = d.DocKey
      LEFT JOIN Item i ON i.ItemCode = d.ItemCode
      WHERE h.DocDate >= ?
      ORDER BY d.DtlKey""", SINCE)
    names = [c[0] for c in cur.description]
    n = 0
    for r in cur.fetchall():
        o = {k: val(v) for k, v in zip(names, r)}
        if t == "IV":
            o["PartyName"] = sha(o["PartyName"])
            o["PartyNameHashed"] = True
        rows.append(o)
        n += 1
    print(f"  {t}: {n} detail rows since {SINCE}")

p = os.path.join(OUT, "ac-listing-lines.json.gz")
with gzip.open(p, "wt", encoding="utf-8") as f:
    json.dump(rows, f)
manifest = {
    "exportedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
    "database": DB,
    "since": SINCE,
    "rows": {t: sum(1 for r in rows if r["T"] == t) for t in SPECS},
    "producer": "backend/scripts/export-ac-listing-lines.py",
}
with open(os.path.join(OUT, "ac-listing-lines-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
print("  wrote", p, os.path.getsize(p), "bytes")
