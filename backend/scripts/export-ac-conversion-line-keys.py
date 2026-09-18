"""Export the book's source line for every line of the ERP-numbered delivery
orders, goods receipts, invoices and purchase orders, for
stamp-conversion-line-keys.mjs.

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
Three small reads (ERP-numbered documents only), so it does not compete with the
write-back for the book's locks the way a wide scan did on 2026-09-07.

THE PURCHASE-ORDER LANE (docs/bugs/0903). A purchase order the write-back raised
FROM a sales order is a transfer as well, but AutoCount keeps that link on the
purchase line itself, `PODTL.FromSODtlKey`, and writes no DocTransfer row for
it. Each `HC-PO-` line is exported with that key as its source; a key that names
no sales line in the book refuses the snapshot. Lines of a purchase order the
write-back CREATED carry no source and are exported with none.

THE INVOICE LANES (docs/bugs/0914). A sales invoice the write-back converts
from a delivery order, and a purchase invoice from a goods receipt, keep no line
key for the same reason a delivery order did (0897): HC-SI-2609-001 reached the
book whole on 2026-09-10 and all eight of its ERP lines are still keyless, so
its later edit could never be sent. The book names each invoice line's source in
DocTransfer exactly as it does for a DO, so the lanes read the same way:
`HC-SI-` from a DO, `HC-PI-` from a GR. Migrated invoices carry AutoCount's own
numbers (`I-2410-...`, `PI-00...`) and are not in these lanes.

CARRIED-OVER DOCUMENTS (docs/bugs/0919). A delivery order or purchase order
carried over from AutoCount keeps AutoCount's own number (DO-010936) and some of
its rows reached the ERP with no key: sofa pieces the cutover split out, and
lines added at the 2026-09-07 decomposition. An edit of one is refused whole,
as HC-DO-010936 was on 2026-09-15. CARRIED_OVER_FILE names those documents (the
output of list-carried-over-keyless-documents.mjs) and they are exported through
the same DO and PO lanes, so the same pairing rule and shape checks apply.

WHAT ELSE EACH LINE CARRIES (docs/bugs/0902). `qty` and `transferredOn` — how
many DocTransfer rows take this line further (a DO line into an invoice, a GR
line into a purchase invoice). retire-book-only-conversion-lines.mjs zeroes a
book line the ERP no longer holds, and only a line nothing downstream holds.

RE-RUN: overwrites data/ac-conversion-line-keys.json.gz with a fresh cut. It
writes nothing to the book and nothing to the ERP.

Env: AC_CRED_FILE (required, a file holding the sa2 password - never printed),
AC_HOST / AC_DB / AC_USER / AC_DRIVER as for export-ac-live.py.
CARRIED_OVER_FILE (optional): JSON {"DO": [...], "PO": [...]} of AutoCount numbers.
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

CARRIED = {"DO": [], "PO": []}
if os.environ.get("CARRIED_OVER_FILE"):
    with open(os.environ["CARRIED_OVER_FILE"], encoding="utf-8") as fh:
        listed = json.load(fh)
    for t in CARRIED:
        CARRIED[t] = sorted({str(n) for n in listed.get(t, []) if str(n)})
    if any(n.startswith("HC-") for t in CARRIED for n in CARRIED[t]):
        sys.exit("CARRIED_OVER_FILE names an ERP-numbered document; it takes AutoCount's own numbers")


def carried_clause(doc_type):
    """`OR h.DocNo IN (...)` and its parameters, for the carried-over documents of a lane."""
    nos = CARRIED.get(doc_type, [])
    if not nos:
        return "", []
    return " OR h.DocNo IN (" + ",".join("?" * len(nos)) + ")", nos

# (docType, header table, detail table, ERP number prefix, expected source type)
LANES = (
    ("DO", "DO", "DODTL", "HC-DO-%", "SO"),
    ("GR", "GR", "GRDTL", "HC-GRN-%", "PO"),
    ("IV", "IV", "IVDTL", "HC-SI-%", "DO"),
    ("PI", "PI", "PIDTL", "HC-PI-%", "GR"),
)

rows = []
bad = []
counts = {}
for doc_type, hdr, dtl, prefix, source_type in LANES:
    extra_sql, extra_args = carried_clause(doc_type)
    lane = cur.execute(
        f"""SELECT h.DocNo, d.DtlKey, t.FromDocDtlKey, t.FromDocType, d.ItemCode, h.Cancelled,
                   d.Qty,
                   (SELECT COUNT(*) FROM DocTransfer o WITH (NOLOCK)
                     WHERE o.FromDocDtlKey = d.DtlKey AND o.FromDocType = ?) AS TransferredOn
              FROM {hdr} h WITH (NOLOCK)
              JOIN {dtl} d WITH (NOLOCK) ON d.DocKey = h.DocKey
              LEFT JOIN DocTransfer t WITH (NOLOCK) ON t.ToDocDtlKey = d.DtlKey AND t.ToDocType = ?
             WHERE h.DocNo LIKE ?{extra_sql}
             ORDER BY h.DocNo, d.DtlKey""",
        doc_type, doc_type, prefix, *extra_args).fetchall()
    seen = {}
    for doc_no, dtl_key, from_key, from_type, item_code, cancelled, qty, transferred_on in lane:
        seen[dtl_key] = seen.get(dtl_key, 0) + 1
        if from_type is not None and from_type != source_type:
            bad.append(f"{doc_type} {doc_no} line {dtl_key} is transferred from a {from_type}, expected {source_type}")
        rows.append([doc_type, doc_no, int(dtl_key),
                     int(from_key) if from_key is not None else None,
                     item_code, cancelled == "T", float(qty), int(transferred_on)])
    multi = [k for k, n in seen.items() if n > 1]
    if multi:
        bad.append(f"{doc_type}: {len(multi)} line(s) have more than one DocTransfer row, e.g. {multi[:5]}")
    counts[doc_type] = {
        "documents": len({r[1] for r in rows if r[0] == doc_type}),
        "lines": len(seen),
        "lines_without_a_source": sum(1 for r in rows if r[0] == doc_type and r[3] is None),
    }
po_extra_sql, po_extra_args = carried_clause("PO")
po_lane = cur.execute(
    f"""SELECT h.DocNo, d.DtlKey, d.FromSODtlKey, s.DtlKey, d.ItemCode, h.Cancelled, d.Qty,
              (SELECT COUNT(*) FROM DocTransfer o WITH (NOLOCK)
                WHERE o.FromDocDtlKey = d.DtlKey AND o.FromDocType = 'PO') AS TransferredOn
         FROM PO h WITH (NOLOCK)
         JOIN PODTL d WITH (NOLOCK) ON d.DocKey = h.DocKey
         LEFT JOIN SODTL s WITH (NOLOCK) ON s.DtlKey = d.FromSODtlKey
        WHERE h.DocNo LIKE 'HC-PO-%'{po_extra_sql}
        ORDER BY h.DocNo, d.DtlKey""", *po_extra_args).fetchall()
po_seen = set()
for doc_no, dtl_key, from_key, sales_line, item_code, cancelled, qty, transferred_on in po_lane:
    if dtl_key in po_seen:
        bad.append(f"PO {doc_no} line {dtl_key} was read twice")
    po_seen.add(dtl_key)
    if from_key is not None and sales_line is None:
        bad.append(f"PO {doc_no} line {dtl_key} names sales line {from_key}, which the book does not hold")
    rows.append(["PO", doc_no, int(dtl_key),
                 int(from_key) if from_key is not None else None,
                 item_code, cancelled == "T", float(qty), int(transferred_on)])
counts["PO"] = {
    "documents": len({r[1] for r in rows if r[0] == "PO"}),
    "lines": len(po_seen),
    "lines_without_a_source": sum(1 for r in rows if r[0] == "PO" and r[3] is None),
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
    "grain": "one row per line of an ERP-numbered DO / GR / IV / PI / PO in the book, with its source line (DocTransfer for a DO, GR, IV or PI; PODTL.FromSODtlKey for a PO)",
    "fields": ["docType", "docNo", "toDtlKey", "fromDtlKey", "itemCode", "cancelled", "qty", "transferredOn"],
    "counts": counts,
    "carried_over": CARRIED,
    "rows": rows,
}
dest = os.path.join(OUT, "ac-conversion-line-keys.json.gz")
with gzip.open(dest, "wb") as fh:
    fh.write(json.dumps(snapshot, ensure_ascii=False).encode("utf-8"))
print(f"wrote {dest}")
print(json.dumps(counts, indent=1))
