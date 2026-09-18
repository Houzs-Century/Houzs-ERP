# -*- coding: utf-8 -*-
"""
census-ac-line-photos.py — count EVERY line in the live AED_HOUZS book that
carries an order-slip drawing, with NO checkpoint, and never read a picture
byte.

READ-ONLY against AutoCount. `SELECT` only, under READ UNCOMMITTED, opens no
ERP database, and holds no credential beyond the password file AC_CRED_FILE
names. It never prints that password.

WHY THIS EXISTS
  `export-ac-line-photos.py` resumes at `DtlKey > checkpoint`. DtlKey is the
  identity of the LINE, not of the PICTURE: staff paste a drawing onto an order
  that already exists, so the line keeps its old low key and the resume cannot
  see it (docs/bugs/0655). It says nothing while failing — it prints `new: 0`.
  Every "the book does not state the build" conclusion rests on the export
  being complete, and nobody had checked that without the checkpoint.

  So this walks the WHOLE DtlKey range. It is the book side of the comparison;
  the verdict is computed by `census-line-photo-report.mjs` from the tested
  pure module `lib/line-photo-census.mjs`.

WHY IT DOES NOT JUST RUN `FORCE=1`
  Because that is the instrument that takes the book down. FORCE re-downloads
  every `FurtherDescription` LOB (one measured line is 458,878 bytes) from the
  same SQL instance the ERP write-back uses, and on 2026-09-07 an unbounded
  scan of exactly that column made `SalesOrder.InternalSave()` fail with
  `The wait operation timed out` — a lock timeout that reads exactly like a
  permissions refusal. This census therefore:
    · reads in bounded `DtlKey > @lo AND DtlKey <= @hi` windows;
    · never selects `FurtherDescription` itself — only a COUNT computed
      server-side, so the bytes never cross the link;
    · runs READ UNCOMMITTED / NOLOCK, so it takes no shared lock the
      write-back can queue behind.

POSITIVE CONTROL
  A census that returns nothing looks exactly like a clean book. Before the
  numbers are believed, `--control <DtlKey>` (or the highest key in the
  existing manifest) must come back carrying a picture. If it does not, the
  script exits 3 rather than report an empty book.

Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB (default AED_HOUZS)
      AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
      OUT_DIR  (default C:/Users/User/Desktop/.ac-photos)
      SIDE     so | po | both  (default both)
      WINDOW   DtlKeys per round trip (default 20000)

Usage:
  AC_CRED_FILE=<path> python backend/scripts/census-ac-line-photos.py
"""
import json
import os
import sys
import time

HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
OUT = os.environ.get("OUT_DIR", "C:/Users/User/Desktop/.ac-photos")
SIDE = os.environ.get("SIDE", "both").lower()
WINDOW = int(os.environ.get("WINDOW", "20000") or 20000)

# Header table and detail table per side. The document-number exclusions are
# NOT invented here — they are exactly what export-ac-line-photos.py filters on,
# so the census and the export describe the same population.
SIDES = {
    "so": {"hdr": "SO", "dtl": "SODTL"},
    "po": {"hdr": "PO", "dtl": "PODTL"},
}


def log(msg=""):
    print(msg, flush=True)


def census_side(cn, side):
    cfg = SIDES[side]
    cur = cn.cursor()
    cur.execute("SELECT MIN(DtlKey), MAX(DtlKey) FROM %s" % cfg["dtl"])
    lo, hi = cur.fetchone()
    cur.close()
    if lo is None:
        log("  %s: the detail table is EMPTY — refusing to call that a clean census." % side.upper())
        sys.exit(3)

    # The picture count, computed server-side so the RTF never crosses the link.
    # '{\pict' is 6 characters = 12 bytes of NVARCHAR, hence the /12.
    pics_expr = (
        "(DATALENGTH(CAST(d.FurtherDescription AS NVARCHAR(MAX))) - "
        " DATALENGTH(REPLACE(CAST(d.FurtherDescription AS NVARCHAR(MAX)), '{\\pict', ''))) / 12"
    )
    sql = (
        "SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo, d.DtlKey, %s AS pics "
        "FROM %s d WITH (NOLOCK) JOIN %s h WITH (NOLOCK) ON h.DocKey = d.DocKey "
        "WHERE d.DtlKey > ? AND d.DtlKey <= ? "
        "AND d.FurtherDescription IS NOT NULL "
        "AND d.FurtherDescription LIKE '%%{\\pict%%' "
        "AND h.DocNo NOT LIKE 'HC-%%' AND h.DocNo NOT LIKE 'ZZ%%' "
        "ORDER BY d.DtlKey"
    ) % (pics_expr, cfg["dtl"], cfg["hdr"])

    rows = []
    t0 = time.time()
    windows = 0
    cursor_lo = lo - 1
    while cursor_lo < hi:
        cursor_hi = min(cursor_lo + WINDOW, hi)
        cur = cn.cursor()
        cur.execute(sql, cursor_lo, cursor_hi)
        for r in cur.fetchall():
            rows.append({"DocNo": r[0], "DtlKey": int(r[1]), "pics": max(1, int(r[2] or 1))})
        cur.close()
        windows += 1
        cursor_lo = cursor_hi
    dt = time.time() - t0

    pics = sum(r["pics"] for r in rows)
    log("  %s: DtlKey %d..%d in %d window(s) of %d — %d line(s) carry a drawing, %d picture(s) [%.1fs]"
        % (side.upper(), lo, hi, windows, WINDOW, len(rows), pics, dt))
    multi = [r for r in rows if r["pics"] > 1]
    if multi:
        log("       %d line(s) carry more than one picture, max %d"
            % (len(multi), max(r["pics"] for r in multi)))
    return rows


def positive_control(rows, side):
    """Refuse to report an empty book without proving the matcher can match.

    A census that finds nothing and a census that is broken produce the same
    output. The existing manifest is the control: if we already hold pictures
    for this side, at least one of those lines must come back.
    """
    manifest = os.path.join(OUT, "ac-photo-manifest.json.gz" if side == "so" else "ac-po-photo-manifest.json.gz")
    if not os.path.exists(manifest):
        log("       (no existing manifest for %s — no positive control available)" % side.upper())
        return
    import gzip
    held = json.loads(gzip.open(manifest, "rb").read().decode("utf-8"))
    if not held:
        return
    found = {(r["DocNo"], r["DtlKey"]) for r in rows}
    hits = sum(1 for h in held if (h["DocNo"], h["DtlKey"]) in found)
    if hits == 0:
        log("  CONTROL FAILED (%s): the manifest holds %d picture(s) whose lines the census could not"
            % (side.upper(), len(held)))
        log("       find in the book. Refusing to report — an empty census reads as a clean book.")
        sys.exit(3)
    log("       control: %d of %d manifest picture(s) matched a censused line" % (hits, len(held)))


def main():
    if SIDE not in ("so", "po", "both"):
        log("SIDE must be so | po | both (got %r)" % SIDE)
        sys.exit(2)
    if not CRED or not os.path.exists(CRED):
        log("AC_CRED_FILE must point at a file holding only the DB password")
        sys.exit(2)

    import pyodbc

    pwd = open(CRED).read().strip()
    cn = pyodbc.connect(
        "DRIVER={SQL Server Native Client 11.0};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s" % (HOST, DB, USER, pwd),
        timeout=30,
    )
    cur = cn.cursor()
    # No shared locks: the ERP write-back must never queue behind this census.
    cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
    cur.close()

    os.makedirs(OUT, exist_ok=True)
    log("book=%s@%s  out=%s  NO CHECKPOINT — walking the whole DtlKey range" % (DB, HOST, OUT))
    out = {}
    for side in (["so", "po"] if SIDE == "both" else [SIDE]):
        rows = census_side(cn, side)
        positive_control(rows, side)
        path = os.path.join(OUT, "census-%s.json" % side)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False)
        out[side] = (len(rows), sum(r["pics"] for r in rows), path)
    cn.close()

    log("")
    log("CENSUS DONE (no checkpoint, whole book):")
    for side, (n, p, path) in out.items():
        log("  %s: %d line(s) with a drawing, %d picture(s) -> %s" % (side.upper(), n, p, path))
    log("")
    log("Next: node backend/scripts/census-line-photo-report.mjs   (compares against what we hold)")


if __name__ == "__main__":
    main()
