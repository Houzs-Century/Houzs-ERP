# -*- coding: utf-8 -*-
"""
export-ac-invoice-refs.py — regenerate data/ac-invoice-refs.json.gz from the
live AED_HOUZS book (SELECT only).

The file maps which AutoCount invoice each goods receipt / delivery order was
billed on, plus each invoice's header meta — the exact-amount mirror rule in
create-migrated-invoices.mjs runs on it. Its VALUES move daily (new invoices
are raised), and until 2026-08-28 the generator was not in the tree at all: the
committed copy silently aged to 17 days and the dry-run planned from a stale
world (docs/bugs/0561). Shape is byte-compatible with the original:

  { _source, _exportedAt,
    grToPi: { "<GR DocNo>": ["<PI DocNo>", ...] },
    doToIv: { "<DO DocNo>": ["<IV DocNo>", ...] },   # keys verbatim from IVDTL.FromDocNo
    piMeta: { "<PI DocNo>": {date, cancelled, netTotal, currency, rate} },
    ivMeta: { "<IV DocNo>": {date, cancelled, netTotal, currency, rate} } }

Env: AC_HOST (default 10.147.17.100,55500)  AC_DB (default AED_HOUZS)
     AC_USER (default sa2)                  AC_CRED_FILE (password file, required)
Usage: AC_CRED_FILE=<path> python backend/scripts/export-ac-invoice-refs.py
"""
import datetime
import gzip
import json
import os
import sys

import pyodbc

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
if not CRED or not os.path.exists(CRED):
    print("AC_CRED_FILE must point at a file holding only the DB password", file=sys.stderr)
    sys.exit(2)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "ac-invoice-refs.json.gz")

cn = pyodbc.connect(
    "DRIVER={SQL Server Native Client 11.0};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s"
    % (HOST, DB, USER, open(CRED).read().strip()),
    timeout=30,
)
cur = cn.cursor()

def links(dtl, hdr, from_type):
    cur.execute(
        f"""SELECT DISTINCT LTRIM(RTRIM(d.FromDocNo)), LTRIM(RTRIM(h.DocNo))
              FROM {dtl} d JOIN {hdr} h ON h.DocKey = d.DocKey
             WHERE d.FromDocType = '{from_type}' AND d.FromDocNo IS NOT NULL"""
    )
    out = {}
    for src, inv in cur.fetchall():
        out.setdefault(src, []).append(inv)
    for v in out.values():
        v.sort()
    return out

def meta(hdr):
    cur.execute(
        f"""SELECT LTRIM(RTRIM(DocNo)), DocDate, Cancelled, NetTotal, CurrencyCode, CurrencyRate
              FROM {hdr}"""
    )
    out = {}
    for doc, date, cancelled, net, curr, rate in cur.fetchall():
        out[doc] = {
            "date": date.strftime("%Y-%m-%d") if date else None,
            "cancelled": cancelled == "T",
            "netTotal": float(net or 0),
            "currency": (curr or "MYR").strip(),
            "rate": float(rate or 1),
        }
    return out

payload = {
    "_source": "live AED_HOUZS, read-only SELECT, PIDTL/PI + IVDTL/IV",
    "_exportedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
    "grToPi": links("PIDTL", "PI", "GR"),
    "doToIv": links("IVDTL", "IV", "DO"),
    "piMeta": meta("PI"),
    "ivMeta": meta("IV"),
}
cn.close()

with gzip.open(OUT, "wt", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
print(
    "wrote %s  grToPi=%d doToIv=%d piMeta=%d ivMeta=%d exportedAt=%s"
    % (OUT, len(payload["grToPi"]), len(payload["doToIv"]), len(payload["piMeta"]), len(payload["ivMeta"]), payload["_exportedAt"]),
    flush=True,
)
