"""Write src/scm/lib/migrated-receipts-not-invoiced.generated.ts: the goods
receipts (GRNs) carried over from AutoCount that AutoCount never invoiced, so the
ERP may bill them into a purchase invoice like any other GRN (docs/bugs/0918,
purchase-side mirror of export-migrated-deliveries-not-invoiced.py).

WHY. A GRN carried over from AutoCount was refused by every purchase-invoice path
on the premise that AutoCount had already invoiced it. That premise is true for a
GRN AutoCount did bill and false for one it never billed - a payable staff cannot
enter by hand. Whether AutoCount invoiced a GRN lives only in the book (a transfer
from the GR's lines to a purchase invoice), which the Worker cannot read, so the
answer is measured here and committed as a list.

WHAT COUNTS AS "NEVER INVOICED". The book holds the receipt under the number the
ERP mirrors (linked_ac_gr_docno), it has at least one line, and no line of it was
transferred to a purchase invoice that is not cancelled. Anything else - a receipt
the book does not hold, one with any line invoiced, one with no AutoCount number -
stays off the list and stays refused.

INPUT. The JSON printed by list-migrated-receipts.mjs (the ERP side).

READ-ONLY: SELECT only, NOLOCK, a 15-second timeout, batches of 80 documents.

RE-RUN: rewrites the generated file from the book as it is now. The file is
committed, so a change shows as a diff in review.

AUTOCOUNT TABLES - CONFIRMED, but the office MUST re-confirm before trusting a
populated list, because this script has never been run:
  - GR / GRDTL     goods-received header / detail (DocType 'GR'); PI / PIDTL the
                   purchase invoice. Confirmed against scripts/autocount-service/
                   AcSyncService.cs (case "GR": hdr = "GR", dtl = "GRDTL") and
                   export-ac-invoice-refs.py (grToPi = PIDTL/PI, FromDocType 'GR').
  - DocTransfer    line-grain GR-line -> PI-line map, keyed FromDocDtlKey /
                   ToDocDtlKey with FromDocType / ToDocType. Same table and grain
                   the delivery script uses for DO -> IV; GRDTL.FromDocDtlKey is
                   itself unpopulated (0 of 21,746), which is exactly why the join
                   goes through DocTransfer rather than the detail's own key.
  - PI.Cancelled   'T' / 'F'; 'F' is a live invoice.
  TODO (office to confirm on the real book before committing a populated list):
    (1) that DocTransfer IS populated for the GR->PI chain. If it is NOT (as the
        detail-level FromDocDtlKey is not), fall back to the mechanism
        export-ac-invoice-refs.py already relies on for grToPi:
        PIDTL.FromDocType = 'GR' AND PIDTL.FromDocNo = <GR DocNo>, joined to PI for
        Cancelled. That path needs no DocTransfer row.
    (2) that GR.DocNo carries the same string as grns.linked_ac_gr_docno.

Usage:
  node scripts/list-migrated-receipts.mjs > migrated-receipts.json
  AC_CRED_FILE=<path> python scripts/export-migrated-receipts-not-invoiced.py migrated-receipts.json
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is required: pip install pyodbc")

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
DRIVER = os.environ.get("AC_DRIVER", "SQL Server Native Client 11.0")
CRED = os.environ.get("AC_CRED_FILE")
if not CRED or not os.path.exists(CRED):
    sys.exit("set AC_CRED_FILE to a file containing the AutoCount password")
if len(sys.argv) != 2:
    sys.exit("usage: export-migrated-receipts-not-invoiced.py <list-migrated-receipts output>")

erp = json.load(open(sys.argv[1], encoding="utf-8"))
receipts = erp["receipts"]
book_nos = sorted({r["book_no"] for r in receipts if r.get("book_no")})

with open(CRED, encoding="utf-8") as fh:
    password = fh.read().strip()
cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s" % (DRIVER, HOST, DB, USER, password),
    timeout=15, readonly=True)
del password
cn.timeout = 15
cur = cn.cursor()

book = {}
for i in range(0, len(book_nos), 80):
    batch = book_nos[i:i + 80]
    marks = ",".join("?" * len(batch))
    for doc_no, lines, invoiced in cur.execute(
            f"""SELECT h.DocNo, COUNT(DISTINCT d.DtlKey),
                       COUNT(DISTINCT CASE WHEN pi.Cancelled = 'F' THEN d.DtlKey END)
                  FROM GR h WITH (NOLOCK)
                  JOIN GRDTL d WITH (NOLOCK) ON d.DocKey = h.DocKey
                  LEFT JOIN DocTransfer t WITH (NOLOCK) ON t.FromDocDtlKey = d.DtlKey AND t.FromDocType = 'GR' AND t.ToDocType = 'PI'
                  LEFT JOIN PIDTL pd WITH (NOLOCK) ON pd.DtlKey = t.ToDocDtlKey
                  LEFT JOIN PI pi WITH (NOLOCK) ON pi.DocKey = pd.DocKey
                 WHERE h.DocNo IN ({marks})
                 GROUP BY h.DocNo""", *batch).fetchall():
        book[doc_no] = {"lines": int(lines), "invoiced": int(invoiced)}
cn.close()

allowed, held = [], {}
for r in receipts:
    b = book.get(r.get("book_no") or "")
    reason = ("no AutoCount number" if not r.get("book_no")
              else "not in the book" if b is None
              else "no lines in the book" if b["lines"] == 0
              else "invoiced in AutoCount" if b["invoiced"] > 0
              else None)
    if reason:
        held.setdefault(reason, []).append(r["grn_number"])
    else:
        allowed.append(r["grn_number"])

allowed = sorted(set(allowed))
if any(not re.fullmatch(r"HC-GR-[0-9A-Z-]+", n) for n in allowed):
    sys.exit("REFUSING: a receipt number does not have the migrated HC-GR- shape")

cut = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "scm", "lib",
                    "migrated-receipts-not-invoiced.generated.ts")
with open(dest, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("// GENERATED by backend/scripts/export-migrated-receipts-not-invoiced.py - do not edit by hand.\n")
    fh.write("//\n")
    fh.write("// The goods receipts (GRNs) carried over from AutoCount that AutoCount never\n")
    fh.write("// invoiced, measured against the live book (docs/bugs/0918, purchase-side\n")
    fh.write("// mirror). Such a GRN is billed into a purchase invoice in the ERP like any\n")
    fh.write("// other; every other migrated GRN is still refused by the invoice paths\n")
    fh.write("// (routes/purchase-invoices.ts, lib/migrated-chain.ts).\n")
    fh.write(f"// Book read {cut}; ERP list {erp['listedAt']}; company {erp['companyId']}.\n")
    for reason, nos in sorted(held.items()):
        fh.write(f"// Held, {reason}: {len(nos)}.\n")
    fh.write("\n")
    fh.write(f"export const MIGRATED_RECEIPTS_NOT_INVOICED_AS_OF = '{cut}';\n\n")
    fh.write("export const MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT: ReadonlySet<string> = new Set([\n")
    for n in allowed:
        fh.write(f"  '{n}',\n")
    fh.write("]);\n")

print(f"wrote {os.path.normpath(dest)}")
print(f"migrated receipts: {len(receipts)}; never invoiced in AutoCount: {len(allowed)}")
for reason, nos in sorted(held.items()):
    print(f"  held, {reason}: {len(nos)} {nos[:10]}")
