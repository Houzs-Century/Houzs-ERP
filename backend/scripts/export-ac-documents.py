#!/usr/bin/env python
"""Export LIVE AutoCount DOCUMENT state for the drift check.

STRICTLY READ-ONLY. SELECT only — no INSERT/UPDATE/DELETE, no DDL, no SDK. The
account book is the floor's live system and the owner's standing rule is that
the ERP is the only editing surface; this script only ever looks.

WHY IT EXISTS. Hard rule 2 says the ERP is the sole editing surface and the sync
is one-way — "but staff WILL edit in AutoCount out of habit, so DRIFT DETECTION
is still required." Proven on this book: SO-013175 was created by staff in
AutoCount on 2026-08-10, and 12,105 of 13,015 sales orders carry a LastModified
later than their CreatedTimeStamp. Drift is not hypothetical here.

WHY IT IS A SEPARATE STEP. The AutoCount host sits behind ZeroTier on the office
network; a GitHub runner cannot reach it. The ERP half of the comparison needs
the production DSN, which lives in Actions secrets and must not be handed to a
human. So the two halves run in two places: this exporter on a machine on the
ZeroTier network, and check-autocount-drift.mjs in CI against what it committed.
Same split as export-ac-live.py, for the same reason.

WHAT IT EXPORTS
  headers  — all six document types, every row. Small, and the cancel-parity
             and edit-after-write checks both need the whole set.
  lines    — only for documents modified since AC_DRIFT_SINCE (default
             2026-07-01). All 212,883 lines will not fit in a repo, and a
             document the ERP masters is by definition recent. The comparer
             REPORTS a document whose lines are outside the window as
             "lines not in snapshot" rather than calling it a match — an
             unchecked document must never read as a clean one.

  AC_HOST         default 10.147.17.100,55500
  AC_DB           default AED_HOUZS
  AC_USER         default sa2
  AC_CRED_FILE    path to a file containing ONLY the password. Required.
                  The credential is never printed and never written to the repo.
  AC_DRIFT_SINCE  line-export cutoff, default 2026-07-01

  python backend/scripts/export-ac-documents.py
"""
import json, gzip, os, sys, datetime

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is required: pip install pyodbc")

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
SINCE = os.environ.get("AC_DRIFT_SINCE", "2026-07-01")
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


def iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def dump(name, obj):
    p = os.path.join(OUT, name)
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(obj, f)
    print("  wrote {:44s} {:7d} rows  {:>9d} bytes".format(
        name, len(obj), os.path.getsize(p)))


# The party column differs by side of the ledger: sales documents carry a
# Debtor, purchase documents a Creditor. Everything else is common.
DOCS = [
    ("SO", "SO", "SODTL", "DebtorName"),
    ("PO", "PO", "PODTL", "CreditorName"),
    ("DO", "DO", "DODTL", "DebtorName"),
    ("GR", "GR", "GRDTL", "CreditorName"),
    ("IV", "IV", "IVDTL", "DebtorName"),
    ("PI", "PI", "PIDTL", "CreditorName"),
]

headers = {}
lines = {}

for doc_type, ht, dt, party_name in DOCS:
    # ── headers: every row ───────────────────────────────────────────────────
    # Cancelled is char 'T'/'F'. NetTotal is the after-discount document value,
    # which is what a human reads off the printed document.
    # EVERY FIELD HERE IS COMPARED by check-autocount-drift.mjs. DocKey,
    # CreatedTimeStamp and the party CODE were carried at first and compared by
    # nothing; at 53,317 rows that was ~350 KB of committed repo weight buying
    # no signal, so they are gone. A field that earns nothing does not ship.
    cur.execute("""
        SELECT LTRIM(RTRIM(DocNo)), DocDate, LTRIM(RTRIM(ISNULL(%s,''))),
               LTRIM(RTRIM(ISNULL(Ref,''))), Cancelled, NetTotal, LastModified,
               LTRIM(RTRIM(ISNULL(LastModifiedUserID,'')))
          FROM %s""" % (party_name, ht))
    rows = []
    for r in cur.fetchall():
        rows.append({
            "DocNo": r[0],
            "DocDate": iso(r[1]),
            "PartyName": r[2],
            "Ref": r[3],
            "Cancelled": (r[4] or "F").strip().upper() == "T",
            "NetTotal": float(r[5] or 0),
            "LastModified": iso(r[6]),
            "LastModifiedUserID": r[7],
        })
    headers[doc_type] = rows
    print("%s headers: %d (cancelled %d)"
          % (doc_type, len(rows), sum(1 for x in rows if x["Cancelled"])))

    # ── lines: only for documents touched since the cutoff ───────────────────
    # Qty/UnitPrice are what the ERP composes and therefore what it can be held
    # to. Desc2 carries the sofa build (contract item D9), so it is the field a
    # silent AutoCount-side edit is most likely to land in.
    cur.execute("""
        SELECT h.LTRIM_DocNo, d.DtlKey, d.Seq, d.ItemCode, d.Desc2, d.Qty, d.UnitPrice
          FROM (SELECT DocKey, LTRIM(RTRIM(DocNo)) AS LTRIM_DocNo FROM %s
                 WHERE LastModified >= ?) h
          JOIN %s d ON d.DocKey = h.DocKey
         ORDER BY h.LTRIM_DocNo, d.Seq""" % (ht, dt), SINCE)
    lrows = []
    for r in cur.fetchall():
        lrows.append({
            "DocNo": r[0],
            "DtlKey": int(r[1]),
            "Seq": int(r[2] or 0),
            "ItemCode": (r[3] or "").strip(),
            "Desc2": (r[4] or "").strip(),
            "Qty": float(r[5] or 0),
            "UnitPrice": float(r[6] or 0),
        })
    lines[doc_type] = lrows
    print("%s lines since %s: %d" % (doc_type, SINCE, len(lrows)))

# One file per half. The comparer reads both and refuses to run without them.
dump("ac-doc-headers.json.gz", headers)
dump("ac-doc-lines.json.gz", lines)

manifest = {
    "exported_at": stamp,
    "database": DB,
    "host": HOST.split(",")[0],
    "line_cutoff": SINCE,
    "header_counts": {k: len(v) for k, v in headers.items()},
    "line_counts": {k: len(v) for k, v in lines.items()},
}
with open(os.path.join(OUT, "ac-doc-export-manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print("\nmanifest written. Commit backend/scripts/data/ac-doc-*.")
cn.close()
