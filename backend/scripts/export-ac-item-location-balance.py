#!/usr/bin/env python3
"""Pull the LIVE AutoCount per-item-per-location stock balance into a committed
snapshot that backend/scripts/check-stock-truth.mjs compares the ERP against.

WHY A SNAPSHOT AND NOT A LIVE JOIN. The AutoCount box (AED_HOUZS on
10.147.17.100,55500) is reachable only from the owner's machine over ZeroTier.
The ERP's production database is reachable only from a GitHub runner, through
the read-only workflow_dispatch job that holds secrets.DATABASE_URL. No single
process can see both. So the AutoCount side is exported here, committed as a
gzipped snapshot, and the check reads it in CI.

That makes STALENESS the failure mode to defend against: comparing today's ERP
against a week-old AutoCount would print a confident, wrong divergence. Two
defences —
  1. the file records `pulled_at`, and check-stock-truth.mjs prints the age of
     the snapshot on every run and marks it STALE past AC_SNAPSHOT_MAX_AGE_DAYS
     (default 2);
  2. it is written as its own file, NOT on top of data/ac-stock-balance.json.gz.
     That one is the frozen 2026-08-09 CUTOVER snapshot the opening balance was
     imported from, and overwriting it would destroy the audit trail of what the
     ERP was actually opened with.

STRICTLY READ-ONLY. One SELECT against a view, no writes, no DDL, no temp
tables. The credential is read from a file (path in AC_DB_CRED_FILE) and is
never printed, never logged, never written anywhere.

USAGE (from backend/):
  AC_DB_CRED_FILE=<path to the file holding the sa2 password> \
      python scripts/export-ac-item-location-balance.py
Writes scripts/data/ac-item-location-balance.json.gz.
"""
import datetime
import decimal
import gzip
import json
import os
import pathlib
import sys

try:
    import pyodbc
except ImportError:  # pragma: no cover - operator-facing message
    sys.exit("pyodbc is not installed. pip install pyodbc, then re-run.")

# The AutoCount box. Host/port/db/user are not secret and live in the repo so a
# stranger can reproduce the pull; only the password comes from AC_DB_CRED_FILE.
DRIVER = "{SQL Server Native Client 11.0}"
SERVER = "10.147.17.100,55500"
DATABASE = "AED_HOUZS"
UID = "sa2"

OUT = pathlib.Path(__file__).resolve().parent / "data" / "ac-item-location-balance.json.gz"


def main() -> int:
    cred_file = os.environ.get("AC_DB_CRED_FILE")
    if not cred_file:
        return int(bool(sys.stderr.write(
            "AC_DB_CRED_FILE not set. It must point at a file containing ONLY the\n"
            "AutoCount sa2 password. Never pass the password on the command line.\n")))
    pw = pathlib.Path(cred_file).read_text(encoding="utf-8").strip()
    if not pw:
        return int(bool(sys.stderr.write("AC_DB_CRED_FILE is empty. Aborting.\n")))

    cn = pyodbc.connect(
        f"DRIVER={DRIVER};SERVER={SERVER};DATABASE={DATABASE};UID={UID};PWD={pw}",
        timeout=180,
        readonly=True,
    )
    cur = cn.cursor()
    # vItemBalQty is AutoCount's own per-item-per-location on-hand view — the
    # same source the cutover opening balance was taken from, so ERP-vs-AutoCount
    # is compared on AutoCount's own terms rather than on a quantity this repo
    # re-derives from documents.
    cur.execute("SELECT ItemCode, UOM, Location, BalQty FROM vItemBalQty")
    rows = []
    for item, uom, loc, qty in cur.fetchall():
        if isinstance(qty, decimal.Decimal):
            qty = float(qty)
        rows.append({
            "ItemCode": item,
            "UOM": uom,
            "Location": loc,
            "BalQty": qty,
        })
    cn.close()

    payload = {
        "source": "AED_HOUZS.dbo.vItemBalQty (live, read-only)",
        "pulled_at": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "row_count": len(rows),
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(gzip.compress(json.dumps(payload).encode("utf-8"), 9))

    nz = [r for r in rows if r["BalQty"]]
    print(f"rows           : {len(rows)}")
    print(f"non-zero cells : {len(nz)}")
    print(f"non-zero units : {sum(r['BalQty'] for r in nz):g}")
    print(f"locations      : {len(set(r['Location'] for r in rows))}")
    print(f"written        : {OUT}")
    print(f"pulled_at      : {payload['pulled_at']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
