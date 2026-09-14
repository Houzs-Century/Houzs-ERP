"""Export the book's source line for every line of the ERP-numbered delivery
orders and goods receipts, for stamp-conversion-line-keys.mjs.

WHY THIS FILE EXISTS (docs/bugs/0897). A delivery order or goods receipt the
write-back creates in AutoCount comes back as DtlKey, ItemCode and Desc2 per
line, with nothing naming the sales or purchase line each was transferred from,
so the ERP could not prove which of its rows each book line is and stored no
key. AutoCount records that pairing in `DocTransfer` (ToDocDtlKey ->
FromDocDtlKey), not in the detail tables (`DODTL.FromDocDtlKey` is NULL there,
measured 2026-09-14: 0 of 111 and 0 of 51 lines on the documents in question).

SCOPE. Only documents whose book number starts `HC-DO-` / `HC-GRN-` — numbers
the ERP minted, so documents the write-back created. Migrated documents carry
AutoCount's own numbers and are not touched by this lane.

SHAPE, ASSERTED BEFORE A FILE IS WRITTEN. Every exported line has at most one
DocTransfer row, and its source is the expected type (SO for a DO, PO for a GR).
A book that no longer has that shape gets no snapshot: the stamper would read a
file it cannot trust.

READ-ONLY: SELECTs only, NOLOCK, a 15-second statement timeout, no transaction.
Two small reads (ERP-numbered documents only), so it does not compete with the
write-back for the book's locks the way a wide scan did on 2026-09-07.

RE-RUN: overwrites data/ac-conversion-line-keys.json.gz with a fresh cut. It
writes nothing to the book and nothing to the ERP.

Env: AC_CRED_FILE (required, a file holding the sa2 password - never printed),
AC_HOST / AC_DB / AC_USER / AC_DRIVER as for export-ac-live.py.
"""
import gzip
import json
import os
import sys
from datetime import datetime, timezone

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

with open(CRED, encoding="utf-8") as fh:
    password = fh.read().strip()
cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s" % (DRIVER, HOST, DB, USER, password),
    timeout=15, readonly=True)
del password
cn.timeout = 15
cur = cn.cursor()

# (docType, header table, detail table, ERP number prefix, expected source type)
LANES = (
    ("DO", "DO", "DODTL", "HC-DO-%", "SO"),
    ("GR", "GR", "GRDTL", "HC-GRN-%", "PO"),
)

rows = []
bad = []
counts = {}
for doc_type, hdr, dtl, prefix, source_type in LANES:
    lane = cur.execute(
        f"""SELECT h.DocNo, d.DtlKey, t.FromDocDtlKey, t.FromDocType, d.ItemCode, h.Cancelled
              FROM {hdr} h WITH (NOLOCK)
              JOIN {dtl} d WITH (NOLOCK) ON d.DocKey = h.DocKey
              LEFT JOIN DocTransfer t WITH (NOLOCK) ON t.ToDocDtlKey = d.DtlKey AND t.ToDocType = ?
             WHERE h.DocNo LIKE ?
             ORDER BY h.DocNo, d.DtlKey""",
        doc_type, prefix).fetchall()
    seen = {}
    for doc_no, dtl_key, from_key, from_type, item_code, cancelled in lane:
        seen[dtl_key] = seen.get(dtl_key, 0) + 1
        if from_type is not None and from_type != source_type:
            bad.append(f"{doc_type} {doc_no} line {dtl_key} is transferred from a {from_type}, expected {source_type}")
        rows.append([doc_type, doc_no, int(dtl_key),
                     int(from_key) if from_key is not None else None,
                     item_code, cancelled == "T"])
    multi = [k for k, n in seen.items() if n > 1]
    if multi:
        bad.append(f"{doc_type}: {len(multi)} line(s) have more than one DocTransfer row, e.g. {multi[:5]}")
    counts[doc_type] = {
        "documents": len({r[1] for r in rows if r[0] == doc_type}),
        "lines": len(seen),
        "lines_without_a_source": sum(1 for r in rows if r[0] == doc_type and r[3] is None),
    }
cn.close()

if bad:
    print("REFUSING to write a snapshot - the book does not have the shape this file is defined on:")
    for b in bad:
        print("  - " + b)
    sys.exit(3)

snapshot = {
    "exported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "source": f"{DB} live (read-only)",
    "grain": "one row per line of an ERP-numbered DO / GR in the book, with the source line DocTransfer names",
    "fields": ["docType", "docNo", "toDtlKey", "fromDtlKey", "itemCode", "cancelled"],
    "counts": counts,
    "rows": rows,
}
dest = os.path.join(OUT, "ac-conversion-line-keys.json.gz")
with gzip.open(dest, "wb") as fh:
    fh.write(json.dumps(snapshot, ensure_ascii=False).encode("utf-8"))
print(f"wrote {dest}")
print(json.dumps(counts, indent=1))
