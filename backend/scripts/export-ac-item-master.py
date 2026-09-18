"""Export the LIVE AutoCount item master's Description, Item Group and base UOM
into the committed snapshot backend/scripts/data/ac-item-master.tsv.

WHY. The document list exports print each line the way the account book holds
it (owner 2026-09-15). AutoCount's listing Item Description, Item Group and UOM
come from the book's ITEM, and the ERP's own values do not always spell them the
same way; "Item Group" and "UOM" in particular are properties
of the AutoCount ITEM, not of the line, and the ERP's own item_group / uom do not
spell them the same way (bedframe vs BEDFRAME, accessory vs ACC, UNIT vs SET).
A Worker cannot reach the book, so the item master is snapshotted here and
compiled by scripts/gen-autocount-item-master.mjs into
src/services/autocount-item-master.ts.

STRICTLY READ-ONLY. SELECT only — no INSERT/UPDATE/DELETE, no DDL. The session
is opened read-only.

  AC_HOST      default 10.147.17.100,55500
  AC_DB        default AED_HOUZS
  AC_USER      default sa2
  AC_CRED_FILE path to a file containing ONLY the password. Required.
               The credential is never printed and never written to the repo.

  python backend/scripts/export-ac-item-master.py
  node   backend/scripts/gen-autocount-item-master.mjs

RE-RUN: whenever items are opened in AutoCount, then regenerate and commit both.
"""
import os, sys

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

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=180, readonly=True)
cur = cn.cursor()
cur.execute(
    "SELECT ItemCode, Description, ItemGroup, BaseUOM FROM Item "
    "WHERE ItemCode IS NOT NULL ORDER BY ItemCode")
rows = cur.fetchall()
cn.close()


def clean(v):
    s = "" if v is None else str(v).strip()
    if "\t" in s or "\n" in s or "\r" in s:
        sys.exit("a value carries a TAB or newline, which the snapshot uses as a separator: %r" % s)
    return s


out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ac-item-master.tsv")
with open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write("ac_code\tdescription\titem_group\tbase_uom\n")
    for code, description, group, base_uom in rows:
        f.write("\t".join([clean(code), clean(description), clean(group), clean(base_uom)]) + "\n")
print("wrote %s (%d items)" % (out, len(rows)))
