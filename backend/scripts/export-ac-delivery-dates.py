#!/usr/bin/env python
"""Export the LIVE AutoCount book's per-LINE delivery dates (SODTL.DeliveryDate,
DODTL.DeliveryDate) into a committed snapshot.

WHY A SNAPSHOT. The inbound AutoCount pull does not carry the line delivery
date: the middleware's /DeliveryOrder/getSince projection is nine header
columns, and the delivery date lives on the LINE (DODTL/SODTL), not the header.
So once a document is imported, a later change to its delivery date in AutoCount
never reaches the ERP. Proven 2026-09-11 on SO-011302 / DO-011559 (HC12445):
the committed 2026-08-11 snapshot (ac-fidelity-so-lines) shows the book itself
said 05/09 at import time and says 19/09 today, while the ERP still holds 05/09.
A CI runner is not on the AutoCount network, so the repair reads this file.

STRICTLY READ-ONLY. SELECT only, under READ UNCOMMITTED so a wide read cannot
take locks that starve the outbound write-back (docs/bugs: a wide scan once made
InternalSave time out).

  AC_HOST      default 10.147.17.100,55500
  AC_DB        default AED_HOUZS
  AC_USER      default sa2
  AC_CRED_FILE path to a file holding ONLY the password. Required. Never printed.

  python backend/scripts/export-ac-delivery-dates.py
"""
import datetime
import gzip
import json
import os
import sys

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

cn = pyodbc.connect(
    "DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (DRIVER, HOST, DB, USER, open(CRED).read().strip()), timeout=300)
cur = cn.cursor()
cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")


def d(v):
    return None if v is None else v.strftime("%Y-%m-%d")


def rows(q):
    cur.execute(q)
    cols = [c[0] for c in cur.description]
    out = []
    for r in cur.fetchall():
        out.append({c: (d(v) if hasattr(v, "strftime") else (None if v is None else str(v)))
                    for c, v in zip(cols, r)})
    return out


# One row per document: the doc date plus the SPREAD of its line delivery dates.
# min == max on all but a handful, which is what lets a header field take min;
# where they differ the repair leaves the header alone and fixes lines only.
so = rows("""select h.DocNo, h.DocDate,
                    minDeliveryDate = min(d.DeliveryDate),
                    maxDeliveryDate = max(d.DeliveryDate),
                    lines = count(*),
                    dated = sum(case when d.DeliveryDate is null then 0 else 1 end)
               from SO h join SODTL d on d.DocKey = h.DocKey
              group by h.DocNo, h.DocDate""")
do = rows("""select h.DocNo, h.DocDate,
                    minDeliveryDate = min(d.DeliveryDate),
                    maxDeliveryDate = max(d.DeliveryDate),
                    lines = count(*),
                    dated = sum(case when d.DeliveryDate is null then 0 else 1 end)
               from DO h join DODTL d on d.DocKey = h.DocKey
              group by h.DocNo, h.DocDate""")
# Per-line, keyed by DtlKey — the ERP keeps it as linked_ac_dtlkey, so a line
# repair needs no item-code matching (which cannot pair a sofa anyway: the book
# keeps one line where the ERP keeps one per compartment).
so_lines = rows("""select d.DtlKey, DocNo = h.DocNo, d.DeliveryDate
                     from SODTL d join SO h on h.DocKey = d.DocKey
                    where d.DeliveryDate is not null""")
do_lines = rows("""select d.DtlKey, DocNo = h.DocNo, d.DeliveryDate
                     from DODTL d join DO h on h.DocKey = d.DocKey
                    where d.DeliveryDate is not null""")
cn.close()

payload = {
    "exported_at": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
    "source": "AED_HOUZS live (read-only)",
    "grain": "one row per document (min/max of its line DeliveryDate) + one row per DtlKey",
    "counts": {"so": len(so), "do": len(do), "so_lines": len(so_lines), "do_lines": len(do_lines)},
    "so": so, "do": do, "so_lines": so_lines, "do_lines": do_lines,
}
os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, "ac-delivery-dates.json.gz")
with gzip.open(path, "wt", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
print("wrote %s  %s" % (path, payload["counts"]))
