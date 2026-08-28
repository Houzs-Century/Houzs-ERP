# -*- coding: utf-8 -*-
"""
export-ac-reimport.py — the ONE exporter for the 2026-08 re-import round.

READ-ONLY against the live AED_HOUZS book (SELECT only — the owner's rule is
that staff keep working in AutoCount while this runs). It rewrites the snapshot
files under backend/scripts/data/ that the import-ac-* pipeline consumes,
REPLACING each file whole, per the cutover ledger's snapshot rule (§6): never
edit a snapshot, swap it and add a ledger line.

WHAT CHANGED vs the 2026-08-09 cut (owner's rulings, 2026-08-27/28 — the round
ledger docs/ac-reimport-2026-08-28-ledger.md carries the quotes):
  1. SALES ORDERS ARE WHOLE DOCUMENTS.  An outstanding order (>=1 line not yet
     fully transferred to a DO) exports ALL of its lines, including lines
     already fully delivered.  Last round exported outstanding LINES only,
     which left 245 delivered lines out and made 39 ERP headers total less
     than AutoCount.  The delivered part of the paper trail comes in through
     the DO mirror (ac-partial-dos.json.gz now carries ALL deliveries of the
     imported orders, not only the partial ones).
  2. PURCHASE ORDERS ARE WHOLE DOCUMENTS TOO, on both lanes:
       lane 1  ac-outstanding-po.json.gz   every PO with >=1 line not fully
                                           received — all its lines.
       lane 2  ac-so-linked-pos.json.gz    every PO raised for a line of an
                                           outstanding SO — all its lines,
                                           INCLUDING fully received POs
                                           (owner: the goods exist and the
                                           customer leg is still open).
     Received quantity is ALWAYS the line's own PODTL.TransferedQty.  GrQty —
     the document-level aggregate that manufactured 130 phantom over-receipts
     last round — is NOT exported at all.
  3. TEST DOCUMENTS ARE EXCLUDED EVERYWHERE: DocNo LIKE 'HC-%' (ERP-born,
     pushed by the write-back) and 'ZZ%' (QA throwaways) never come back in.
  4. The PO->SO line link column is PODTL.FromSODtlKey and the DO->SO line
     link column is DODTL.FromDocDtlKey — both read off sys.columns on
     2026-08-28, not assumed (docs/bugs/0553: the refetch reference SQL
     guessed 'FromDtlKey', which does not exist and had never been run).
  5. ac-stock-layers.json.gz is NOT produced here yet — the receipt-layer
     reconstruction is a separate pass (see the round ledger).

RESUME: the ZeroTier link can drop mid-run (it did, 08S01, on the first full
run).  Every statement retries once on a fresh connection; if the run still
dies, START_AT=<section> re-runs from that section and keeps the files the
earlier invocation already wrote.  Sections, in order:
    so iv dates po1 po2 dos bal costs grrefs links ruler remarks

Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB (default AED_HOUZS)
      AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
      OUT_DIR (default: this script's data/)  START_AT (default: so)

Usage:  AC_CRED_FILE=<path> python backend/scripts/export-ac-reimport.py
"""
import datetime
import decimal
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
OUT = os.environ.get("OUT_DIR", os.path.join(HERE, "data"))

pwd = open(CRED).read().strip()

def connect():
    return pyodbc.connect(
        "DRIVER={SQL Server Native Client 11.0};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s" % (HOST, DB, USER, pwd),
        timeout=30,
    )

cn = connect()
cur = cn.cursor()

# One reconnect-and-retry per statement keeps a long export alive across a
# ZeroTier blip without hiding a genuinely dead link.
def rows_of(sql):
    global cn, cur
    try:
        cur.execute(sql)
    except pyodbc.OperationalError as e:
        print("   link dropped (%s...) — reconnecting, retrying once" % str(e)[:60], flush=True)
        try:
            cn.close()
        except Exception:
            pass
        cn = connect()
        cur = cn.cursor()
        cur.execute(sql)
    cols = [c[0] for c in cur.description]
    out = []
    for r in cur.fetchall():
        d = {}
        for k, v in zip(cols, r):
            if isinstance(v, (datetime.date, datetime.datetime)):
                v = v.isoformat(sep=" ")
            elif isinstance(v, decimal.Decimal):
                v = float(v)
            elif v is not None and not isinstance(v, (str, int, float, bool)):
                v = str(v)
            d[k] = v
        out.append(d)
    return out

def write_gz(name, obj):
    p = os.path.join(OUT, name)
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, default=str)
    n = len(obj) if isinstance(obj, list) else len(obj.get("rows", obj))
    print("wrote %-32s %s rows" % (name, n), flush=True)
    return n

def reload_gz(name):
    with gzip.open(os.path.join(OUT, name), "rt", encoding="utf-8") as f:
        return json.load(f)

NOW = datetime.datetime.now().isoformat(sep=" ")
manifest = {"exported_at": NOW, "source": "%s live (read-only)" % DB, "round": "reimport-v3 2026-08-28", "files": {}}

SECTION_ORDER = ["so", "iv", "dates", "po1", "po2", "dos", "bal", "costs", "grrefs", "links", "ruler", "remarks"]
START_AT = os.environ.get("START_AT", "so")
if START_AT not in SECTION_ORDER:
    print("unknown START_AT %r" % START_AT, file=sys.stderr)
    sys.exit(2)

def want(key):
    run = SECTION_ORDER.index(key) >= SECTION_ORDER.index(START_AT)
    if not run:
        print("skip %-6s (kept from the earlier invocation)" % key, flush=True)
    return run

# ── shared predicates ────────────────────────────────────────────────────────
TEST_H = "h.DocNo NOT LIKE 'HC-%' AND h.DocNo NOT LIKE 'ZZ%'"
# whole-document outstanding: not cancelled, not a test doc, >=1 line not fully
# transferred to a DO.  SODTL.TransferedQty counts DO transfers only —
# TransferedPOQty is a separate counter and never disqualifies (owner's rule).
SO_OUT = (
    "h.Cancelled='F' AND " + TEST_H + " AND EXISTS(SELECT 1 FROM SODTL q "
    "WHERE q.DocKey=h.DocKey AND q.Qty > ISNULL(q.TransferedQty,0))"
)
# invoiced WITHOUT a delivery order = completed cash sale, excluded (owner 2026-08-10)
HAS_IV = (
    "EXISTS(SELECT 1 FROM IVDTL x WHERE x.FromDocType='SO' "
    "AND LTRIM(RTRIM(x.FromDocNo))=LTRIM(RTRIM(h.DocNo)))"
)
# the same two, spelled against the SO alias used inside correlated subqueries
SO_OUT_INNER = (
    "so2.Cancelled='F' AND so2.DocNo NOT LIKE 'HC-%' AND so2.DocNo NOT LIKE 'ZZ%' "
    "AND EXISTS(SELECT 1 FROM SODTL q2 WHERE q2.DocKey=so2.DocKey AND q2.Qty > ISNULL(q2.TransferedQty,0)) "
    "AND NOT EXISTS(SELECT 1 FROM IVDTL x2 WHERE x2.FromDocType='SO' "
    "AND LTRIM(RTRIM(x2.FromDocNo))=LTRIM(RTRIM(so2.DocNo)))"
)

# ── 1. sales orders, whole documents ─────────────────────────────────────────
if want("so"):
    so = rows_of(f"""
        SELECT h.DocKey, LTRIM(RTRIM(h.DocNo)) AS DocNo, h.DocDate, h.DebtorCode, h.DebtorName,
               h.Attention, h.Ref, h.SalesAgent, h.SalesLocation, h.Phone1,
               h.InvAddr1, h.InvAddr2, h.InvAddr3, h.InvAddr4,
               h.DeliverAddr1, h.DeliverAddr2, h.DeliverAddr3, h.DeliverAddr4,
               h.DeliverContact, h.DeliverPhone1,
               d.DtlKey, d.ItemCode, d.Description, d.Desc2, d.Qty, d.UnitPrice,
               d.Location, d.DeliveryDate, d.TransferedQty, d.TransferedPOQty,
               h.UDF_BALANCE, h.UDF_BRANDING, d.UDF_BatchNo, h.UDF_PAYEMENT,
               h.UDF_PDate, h.UDF_VENUE
          FROM SO h JOIN SODTL d ON d.DocKey = h.DocKey
         WHERE {SO_OUT} AND NOT ({HAS_IV})
         ORDER BY h.DocNo, d.DtlKey""")
    manifest["files"]["ac-outstanding-so.json.gz"] = write_gz("ac-outstanding-so.json.gz", so)
    delivered = sum(1 for r in so if float(r["Qty"] or 0) <= float(r["TransferedQty"] or 0))
    print("   SO docs=%d, lines=%d (already-delivered lines included: %d)"
          % (len({r["DocNo"] for r in so}), len(so), delivered), flush=True)
else:
    so = reload_gz("ac-outstanding-so.json.gz")
    manifest["files"]["ac-outstanding-so.json.gz"] = len(so)
so_docs = sorted({r["DocNo"] for r in so})

# ── 2. the excluded invoiced-direct list ─────────────────────────────────────
if want("iv"):
    iv = rows_of(f"SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo FROM SO h WHERE {SO_OUT} AND {HAS_IV} ORDER BY h.DocNo")
    manifest["files"]["ac-so-iv-excluded.json.gz"] = write_gz("ac-so-iv-excluded.json.gz", [r["DocNo"] for r in iv])
else:
    manifest["files"]["ac-so-iv-excluded.json.gz"] = len(reload_gz("ac-so-iv-excluded.json.gz"))

# ── 3. processing + delivery dates, per line (backfill-so-dates reads these keys)
if want("dates"):
    dates = [
        {"DocNo": r["DocNo"], "ItemCode": r["ItemCode"], "PDate": r["UDF_PDate"], "DelivDate": r["DeliveryDate"]}
        for r in so
    ]
    manifest["files"]["ac-so-dates.json.gz"] = write_gz("ac-so-dates.json.gz", dates)
else:
    manifest["files"]["ac-so-dates.json.gz"] = len(reload_gz("ac-so-dates.json.gz"))

# ── 4. purchase orders lane 1: whole docs with >=1 outstanding line ──────────
if want("po1"):
    po1 = rows_of(f"""
        SELECT h.DocKey, LTRIM(RTRIM(h.DocNo)) AS DocNo, h.DocDate, h.CreditorCode,
               cr.CompanyName AS CreditorName, h.Ref,
               d.DtlKey, d.ItemCode, d.Description, d.Desc2, d.Qty, d.TransferedQty,
               d.UnitPrice, d.Location, d.DeliveryDate, d.FromSODocList, d.FromSODtlKey
          FROM PO h JOIN PODTL d ON d.DocKey = h.DocKey
          LEFT JOIN Creditor cr ON cr.AccNo = h.CreditorCode
         WHERE h.Cancelled='F' AND {TEST_H}
           AND EXISTS(SELECT 1 FROM PODTL q WHERE q.DocKey=h.DocKey AND q.Qty > ISNULL(q.TransferedQty,0))
         ORDER BY h.DocNo, d.DtlKey""")
    manifest["files"]["ac-outstanding-po.json.gz"] = write_gz("ac-outstanding-po.json.gz", po1)
    print("   PO lane1 docs=%d" % len({r["DocNo"] for r in po1}), flush=True)
else:
    po1 = reload_gz("ac-outstanding-po.json.gz")
    manifest["files"]["ac-outstanding-po.json.gz"] = len(po1)

# ── 5. purchase orders lane 2: raised for an outstanding SO line, incl received
if want("po2"):
    po2 = rows_of(f"""
        SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo, h.DocDate, h.CreditorCode,
               cr.CompanyName AS CreditorName, h.Ref, h.Cancelled,
               d.DtlKey, d.ItemCode, d.Description, d.Desc2, d.Qty, d.TransferedQty,
               d.UnitPrice, d.Location, d.DeliveryDate, d.FromSODocList, d.FromSODtlKey
          FROM PO h JOIN PODTL d ON d.DocKey = h.DocKey
          LEFT JOIN Creditor cr ON cr.AccNo = h.CreditorCode
         WHERE h.Cancelled='F' AND {TEST_H}
           AND EXISTS(SELECT 1 FROM PODTL z
                      JOIN SODTL sd ON sd.DtlKey = z.FromSODtlKey
                      JOIN SO so2 ON so2.DocKey = sd.DocKey
                     WHERE z.DocKey = h.DocKey AND {SO_OUT_INNER})
            OR (h.Cancelled='F' AND {TEST_H}
                AND EXISTS(SELECT 1 FROM PODTL z2
                           JOIN SO so2 ON CHARINDEX(LTRIM(RTRIM(so2.DocNo)), ISNULL(z2.FromDocNo,'')) > 0
                          WHERE z2.DocKey = h.DocKey AND {SO_OUT_INNER}))
         ORDER BY h.DocNo, d.DtlKey""")
    manifest["files"]["ac-so-linked-pos.json.gz"] = write_gz("ac-so-linked-pos.json.gz", po2)
    print("   PO lane2 docs=%d" % len({r["DocNo"] for r in po2}), flush=True)
else:
    po2 = reload_gz("ac-so-linked-pos.json.gz")
    manifest["files"]["ac-so-linked-pos.json.gz"] = len(po2)

# ── 6. ALL delivery orders of the imported sales orders (mirror set) ─────────
# The SO membership is expressed as the SAME predicate inline (no 2,756-literal
# IN list — that query is what the link drop killed; the inline form completed
# in minutes when the candidate counting ran).  DODTL's SO-line pointer column
# is discovered, not assumed.
if want("dos"):
    cur.execute("SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.DODTL') AND name LIKE 'From%'")
    do_cols = [r[0] for r in cur.fetchall()]
    so_line_col = "FromSODtlKey" if "FromSODtlKey" in do_cols else ("FromDocDtlKey" if "FromDocDtlKey" in do_cols else None)
    print("   DODTL From* columns: %s -> using %s for SoDtlKey" % (do_cols, so_line_col), flush=True)
    dos = rows_of(f"""
        SELECT LTRIM(RTRIM(o.DocNo)) AS DoNo, o.DocDate AS DoDate, o.DebtorCode, o.DebtorName,
               LTRIM(RTRIM(dd.FromDocNo)) AS SoNo, dd.DtlKey AS DoDtlKey,
               {('dd.' + so_line_col) if so_line_col else 'NULL'} AS SoDtlKey,
               dd.ItemCode, dd.Description AS LineDesc, dd.Desc2, dd.Qty, dd.UnitPrice, dd.Location
          FROM DODTL dd JOIN DO o ON o.DocKey = dd.DocKey
         WHERE o.Cancelled='F' AND dd.FromDocType='SO'
           AND EXISTS(SELECT 1 FROM SO so2
                      WHERE LTRIM(RTRIM(so2.DocNo)) = LTRIM(RTRIM(dd.FromDocNo)) AND {SO_OUT_INNER})
         ORDER BY o.DocNo, dd.DtlKey""")
    manifest["files"]["ac-partial-dos.json.gz"] = write_gz("ac-partial-dos.json.gz", dos)
    keyed = sum(1 for r in dos if r["SoDtlKey"])
    print("   DO docs=%d, lines=%d, SoDtlKey populated on %d"
          % (len({r["DoNo"] for r in dos}), len(dos), keyed), flush=True)
else:
    manifest["files"]["ac-partial-dos.json.gz"] = len(reload_gz("ac-partial-dos.json.gz"))

# ── 7. stock balance snapshot (vItemBalQty, full dump incl zero) ─────────────
if want("bal"):
    bal = rows_of("SELECT ItemCode, UOM, Location, BalQty FROM vItemBalQty ORDER BY ItemCode, Location")
    manifest["files"]["ac-stock-balance.json.gz"] = write_gz("ac-stock-balance.json.gz", bal)
    print("   non-zero cells: %d" % sum(1 for r in bal if float(r["BalQty"] or 0) != 0), flush=True)
else:
    manifest["files"]["ac-stock-balance.json.gz"] = len(reload_gz("ac-stock-balance.json.gz"))

# ── 8+9. opening-cost sources (same shapes as the 2026-08-10 files) ──────────
if want("costs"):
    utd = rows_of("SELECT ItemCode, UOM, Location, BatchNo, UTDQty, UTDCost, AdjustedCost, AverageCost FROM UTDStockCost")
    manifest["files"]["ac-utd-stock-cost.json.gz"] = write_gz("ac-utd-stock-cost.json.gz", utd)
    # The book's column is MostRecentlyCost; the importer reads the key
    # RecentCost (import-ac-stock-balance.mjs:87), so alias it.
    ic = rows_of("""SELECT i.ItemCode, u.UOM, u.Cost, u.RealCost, u.MostRecentlyCost AS RecentCost
                    FROM ItemUOM u JOIN Item i ON i.ItemCode = u.ItemCode
                   WHERE ISNULL(u.Cost,0) <> 0 OR ISNULL(u.RealCost,0) <> 0 OR ISNULL(u.MostRecentlyCost,0) <> 0""")
    manifest["files"]["ac-item-costs.json.gz"] = write_gz("ac-item-costs.json.gz", ic)
else:
    manifest["files"]["ac-utd-stock-cost.json.gz"] = len(reload_gz("ac-utd-stock-cost.json.gz"))
    manifest["files"]["ac-item-costs.json.gz"] = len(reload_gz("ac-item-costs.json.gz"))

# ── 10. receipt/invoice reference index, scoped to the exported POs ──────────
po_docs = sorted({r["DocNo"] for r in po1} | {r["DocNo"] for r in po2})
if want("grrefs"):
    pokeys = "','".join(po_docs)
    grrefs = rows_of(f"""
        SELECT LTRIM(RTRIM(po.DocNo)) AS PoNo, pd.DtlKey AS PoDtlKey, g.ItemCode,
               LTRIM(RTRIM(gr.DocNo)) AS GrNo, gr.DocDate AS GrDate, g.Qty AS GrQty,
               LTRIM(RTRIM(pi.DocNo)) AS PiNo, pi.DocDate AS PiDate
          FROM GRDTL g
          JOIN GR gr ON gr.DocKey = g.DocKey AND gr.Cancelled='F'
          JOIN PO po ON LTRIM(RTRIM(g.FromDocNo)) = LTRIM(RTRIM(po.DocNo)) AND g.FromDocType='PO'
          LEFT JOIN PODTL pd ON pd.DocKey = po.DocKey AND pd.ItemCode = g.ItemCode
          LEFT JOIN PIDTL p2 ON p2.FromDocType='GR' AND LTRIM(RTRIM(p2.FromDocNo)) = LTRIM(RTRIM(gr.DocNo)) AND p2.ItemCode = g.ItemCode
          LEFT JOIN PI pi ON pi.DocKey = p2.DocKey AND pi.Cancelled='F'
         WHERE LTRIM(RTRIM(po.DocNo)) IN ('{pokeys}')
         ORDER BY po.DocNo, g.DocKey""")
    manifest["files"]["ac-gr-refs.json.gz"] = write_gz("ac-gr-refs.json.gz", grrefs)
else:
    manifest["files"]["ac-gr-refs.json.gz"] = len(reload_gz("ac-gr-refs.json.gz"))

# ── 11. the PO->SO line link, for the dedication repair ──────────────────────
if want("links"):
    links = [
        {"DtlKey": r["DtlKey"], "FromSODtlKey": r["FromSODtlKey"], "ItemCode": r["ItemCode"], "DocNo": r["DocNo"]}
        for r in (po1 + po2)
        if r.get("FromSODtlKey") not in (None, 0, "0")
    ]
    seen = set()
    uniq = []
    for r in links:
        if r["DtlKey"] in seen:
            continue
        seen.add(r["DtlKey"])
        uniq.append(r)
    manifest["files"]["ac-po-fromsodtlkey.json.gz"] = write_gz(
        "ac-po-fromsodtlkey.json.gz", {"exportedAt": NOW, "source": DB, "rows": uniq}
    )
else:
    manifest["files"]["ac-po-fromsodtlkey.json.gz"] = len(reload_gz("ac-po-fromsodtlkey.json.gz").get("rows", []))

# ── 12. the ruler: what is outstanding RIGHT NOW, doc numbers only ───────────
if want("ruler"):
    ruler = {
        "exportedAt": NOW,
        "so": so_docs,
        "po": sorted({r["DocNo"] for r in po1}),
        "so_linked_po": sorted({r["DocNo"] for r in po2}),
    }
    manifest["files"]["ac-outstanding-now.json.gz"] = write_gz("ac-outstanding-now.json.gz", ruler)

# ── 13. header remark / note / stock-status text + the delivery-date field ──
# The owner's SO listing (2026-08-28): Remark2 = per-order stock status
# (READY / MATTRESS/ACC / ...), Remark3+Remark4 = notes, the listing's "Note"
# column = UDF_Note (plain text, 481 docs), SalesExemptionExpiryDate = the
# delivery date the staff maintain on the header (533 of 539 equal the earliest
# line date). All five have native scm.mfg_sales_orders columns the SO screen
# reads. SO.Note itself is NOT exported: the only 2 docs that fill it hold an
# RTF-embedded PICTURE (megabytes of hex), not words.
if want("remarks"):
    rem = rows_of(f"""
        SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo, h.Remark2, h.Remark3, h.Remark4,
               h.UDF_Note, h.SalesExemptionExpiryDate
          FROM SO h
         WHERE {SO_OUT} AND NOT ({HAS_IV})
         ORDER BY h.DocNo""")
    manifest["files"]["ac-so-remarks.json.gz"] = write_gz("ac-so-remarks.json.gz", rem)
    r2 = sum(1 for r in rem if (r["Remark2"] or "").strip())
    print("   remarks: %d docs, Remark2 filled on %d" % (len(rem), r2), flush=True)

with open(os.path.join(OUT, "ac-reimport-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("\nmanifest written. NOT produced here (separate passes): ac-stock-layers.json.gz,", flush=True)
print("photo manifests, fidelity truth (run export-ac-fidelity-truth.py), live ruler (export-ac-live.py).", flush=True)
cn.close()
