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
import time

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
    try:
        with gzip.open(os.path.join(OUT, name), "rt", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        # a skipped section's receipt when OUT_DIR holds no earlier files
        # (e.g. ONLY=<section> into a scratch OUT_DIR); the count reads 0
        print("   (no earlier %s in OUT_DIR — skipped section left empty)" % name, flush=True)
        return []

NOW = datetime.datetime.now().isoformat(sep=" ")
manifest = {"exported_at": NOW, "source": "%s live (read-only)" % DB, "round": "reimport-v3 2026-08-28", "files": {}}

SECTION_ORDER = ["so", "iv", "dates", "po1", "po2", "dos", "bal", "costs", "grrefs", "links", "ruler", "remarks", "stamps", "hdr"]
START_AT = os.environ.get("START_AT", "so")
if START_AT not in SECTION_ORDER:
    print("unknown START_AT %r" % START_AT, file=sys.stderr)
    sys.exit(2)
# ONLY=<section> runs exactly that one section and touches no other file.
# START_AT runs from a section ONWARDS — on 2026-08-28 a "refresh just the
# dates" attempt used START_AT, re-exported the whole tail, and clobbered two
# mid-round snapshots before being killed (restored from git). Mid-round
# refreshes must be surgical.
ONLY = os.environ.get("ONLY")
if ONLY and ONLY not in SECTION_ORDER:
    print("unknown ONLY %r" % ONLY, file=sys.stderr)
    sys.exit(2)
if ONLY == "ruler":
    # the ruler summarises the so/po1/po2 sections; alone it would summarise
    # whatever happens to be reloadable and read as a fresh census
    print("ONLY=ruler refused — the ruler is derived; use START_AT=ruler", file=sys.stderr)
    sys.exit(2)

SECTIONS_RUN = []

def want(key):
    if ONLY:
        run = key == ONLY
    else:
        run = SECTION_ORDER.index(key) >= SECTION_ORDER.index(START_AT)
    if not run:
        print("skip %-6s (kept from the earlier invocation)" % key, flush=True)
    else:
        SECTIONS_RUN.append(key)
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
    manifest["files"]["ac-po-fromsodtlkey.json.gz"] = len((reload_gz("ac-po-fromsodtlkey.json.gz") or {}).get("rows", []))

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


# ── 14. document STAMPS + conversion edges: the DELTA lane ───────────────────
# WHY THIS SECTION EXISTS. Every importer in this directory is INSERT-ONLY
# (`ON CONFLICT (doc_no) DO NOTHING`), so a re-run brings in NEW documents and
# silently ignores every already-migrated document that CHANGED in AutoCount
# since the last cut. Nothing else in this export carries a timestamp, so
# "which documents moved?" was unanswerable without this.
#
# HOW IT IS SHAPED, and why the shape is not negotiable. DESKTOP-TDH50IT\A2006
# is the LIVE book and the ERP write-back runs against it: on 2026-09-07 an
# unbounded scan of a picture column made SalesOrder.InternalSave() fail with
# "The wait operation timed out", and the identical test passed once the scan
# was stopped. So this section:
#   * selects HEADER columns only - never Note/FurtherDescription/any picture
#     column, which is the read that starved it;
#   * pages by DocKey with an explicit range predicate (keyset, not OFFSET),
#     so every statement touches a bounded slice of one index;
#   * sleeps STAMP_PAUSE_MS between pages, leaving the book to other writers;
#   * runs under a per-statement timeout (STAMP_TIMEOUT_S, default 15s) so a
#     statement that goes wrong is killed rather than left holding the book.
#
# SINCE bounds it to the delta: the boundary is the last import cut, so the
# whole section is ~1k documents rather than 55k.
if want("stamps"):
    SINCE = os.environ.get("SINCE", "2026-08-29")
    PAGE = int(os.environ.get("STAMP_PAGE", "2000"))
    PAUSE = float(os.environ.get("STAMP_PAUSE_MS", "250")) / 1000.0
    cn.timeout = int(os.environ.get("STAMP_TIMEOUT_S", "15"))

    # (type, header table, detail table, the party column, the detail's
    #  source-document columns).  FromDocType is NULL on PODTL even for real
    #  production conversions (verified on PO-010163 <- SO-013423 and on a
    #  fresh test document), so the PO lane reads FromSODtlKey + FromDocNo and
    #  never filters on FromDocType.  Every other type does carry it.
    STAMP_TYPES = [
        ("SO", "SO", "SODTL", "DebtorCode", False),
        ("PO", "PO", "PODTL", "CreditorCode", False),
        ("DO", "DO", "DODTL", "DebtorCode", True),
        ("IV", "IV", "IVDTL", "DebtorCode", True),
        ("GR", "GR", "GRDTL", "CreditorCode", True),
        ("PI", "PI", "PIDTL", "CreditorCode", True),
    ]

    def paged(table, cols, where, order_key="DocKey"):
        """Keyset-paged read. Bounded slice per statement, pause between."""
        out, last, pages = [], -1, 0
        while True:
            sql = (
                "SELECT TOP (%d) %s FROM %s WHERE %s AND %s > %d ORDER BY %s"
                % (PAGE, cols, table, where, order_key, last, order_key)
            )
            chunk = rows_of(sql)
            if not chunk:
                break
            out.extend(chunk)
            last = int(chunk[-1][order_key])
            pages += 1
            if len(chunk) < PAGE:
                break
            time.sleep(PAUSE)
        return out, pages

    stamps = {}
    edges = {}
    for kind, h, d, party, has_type in STAMP_TYPES:
        moved = "(h.CreatedTimeStamp >= '%s' OR h.LastModified >= '%s')" % (SINCE, SINCE)
        hdrs, pages = paged(
            "%s h" % h,
            ("h.DocKey, LTRIM(RTRIM(h.DocNo)) AS DocNo, h.DocDate, h.Cancelled, "
             "h.%s AS PartyCode, h.CreatedTimeStamp AS Created, h.LastModified AS Modified" % party),
            "%s AND h.DocNo NOT LIKE 'HC-%%' AND h.DocNo NOT LIKE 'ZZ%%'" % moved,
            order_key="DocKey",
        )
        stamps[kind] = hdrs
        created = sum(1 for r in hdrs if r["Created"] and str(r["Created"]) >= SINCE)
        print("   %-3s stamps=%-5d (created %-4d edited %-4d) in %d page(s)"
              % (kind, len(hdrs), created, len(hdrs) - created, pages), flush=True)
        time.sleep(PAUSE)

        # the conversion edges of exactly those documents, keyed by DtlKey
        keys = [int(r["DocKey"]) for r in hdrs]
        rows = []
        for i in range(0, len(keys), 400):
            batch = ",".join(str(k) for k in keys[i:i + 400])
            if not batch:
                continue
            frm = ("d.FromDocType, " if has_type else "NULL AS FromDocType, ")
            sod = ("d.FromSODtlKey, " if kind == "PO" else "NULL AS FromSODtlKey, ")
            rows.extend(rows_of(
                "SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo, d.DtlKey, d.ItemCode, d.Qty, "
                + frm + sod +
                "LTRIM(RTRIM(d.FromDocNo)) AS FromDocNo "
                "FROM %s d JOIN %s h ON h.DocKey = d.DocKey "
                "WHERE d.DocKey IN (%s) ORDER BY d.DtlKey" % (d, h, batch)))
            time.sleep(PAUSE)
        edges[kind] = rows
        linked = sum(1 for r in rows if (r["FromDocNo"] or "").strip())
        print("   %-3s edges=%-6d (%d carry a source document)" % (kind, len(rows), linked), flush=True)

    # CHAIN CLOSURE. An IV is raised from a DO and a PI from a GR (measured on
    # this cut: IV.FromDocType is DO on all 63 sources, PI.FromDocType is GR on
    # all 60) — so "which sales order is this invoice for?" needs one more hop,
    # and the parent DO/GR is usually OLDER than SINCE and therefore absent from
    # the stamps above. Without this step 58 of 63 IV sources and 39 of 60 PI
    # sources report as untraceable. One bounded lookup per 400 parents, header
    # columns only, same pause.
    parents = {"DO": set(), "GR": set()}
    have = {k: {r["DocNo"] for r in stamps.get(k, [])} for k in ("DO", "GR")}
    for child, parent_type in (("IV", "DO"), ("PI", "GR")):
        for r in edges.get(child, []):
            f = (r.get("FromDocNo") or "").strip()
            if r.get("FromDocType") == parent_type and f and f not in have[parent_type]:
                parents[parent_type].add(f)
    closure = {}
    for kind, dtl in (("DO", "DODTL"), ("GR", "GRDTL")):
        want_docs = sorted(parents[kind])
        rows = []
        for i in range(0, len(want_docs), 400):
            lit = "','".join(d.replace("'", "''") for d in want_docs[i:i + 400])
            if not lit:
                continue
            rows.extend(rows_of(
                "SELECT LTRIM(RTRIM(h.DocNo)) AS DocNo, MIN(d.FromDocType) AS FromDocType, "
                "MIN(LTRIM(RTRIM(d.FromDocNo))) AS FromDocNo "
                "FROM %s d JOIN %s h ON h.DocKey = d.DocKey "
                "WHERE LTRIM(RTRIM(h.DocNo)) IN ('%s') AND d.FromDocNo IS NOT NULL "
                "GROUP BY LTRIM(RTRIM(h.DocNo))" % (dtl, kind, lit)))
            time.sleep(PAUSE)
        closure[kind] = rows
        print("   %-3s chain closure: %d of %d parent(s) resolved one hop further"
              % (kind, len(rows), len(want_docs)), flush=True)

    # The receipt lives INSIDE the payload (exportedAt / since / source), not in
    # ac-reimport-manifest.json. ONLY=<section> rewrites that manifest from
    # whatever this invocation touched, and the ruler and remarks sections have
    # no reload branch — so recording here would DELETE two other sections'
    # entries every time the stamps are re-cut alone. sync-ac-delta.mjs reads
    # the age off the payload and refuses a stale one.
    # TIMEZONE-AWARE, unlike the manifest's NOW. This stamp is COMPARED — the
    # planner refuses a stale snapshot — and it is written on a UTC+8 desktop
    # and read on a UTC runner. `datetime.now()` is naive, so the first prod
    # dispatch computed the snapshot's age as MINUS 0.32 days and refused a
    # snapshot cut 20 minutes earlier. A timestamp that is only ever printed can
    # be naive; one that is subtracted cannot.
    exported_at = datetime.datetime.now().astimezone().isoformat()
    write_gz(
        "ac-doc-stamps.json.gz",
        {"rows": {"exportedAt": exported_at, "since": SINCE, "source": DB,
                  "stamps": stamps, "edges": edges, "closure": closure}},
    )

# ── 15. HEADER MASTER, every document, every field ──────────────────────────
# WHY THIS SECTION EXISTS. Section 1 exports the SO header JOINED to its lines,
# and only for the OUTSTANDING population. Two consequences the header lane
# cannot live with:
#
#   * a document that WAS outstanding when we copied it and has since been
#     fully delivered drops out of that predicate — and the ERP still holds it,
#     so its header master must still be kept current. Filtering by SO_OUT here
#     would quietly define "complete" as "still outstanding", which is the exact
#     substitution the owner ruled out on 2026-09-07.
#   * the fields no importer read at insert (Attention, the delivery address,
#     DisplayTerm, UDF_ToPONo, CurrencyCode) are not in any existing cut, so
#     "the ERP is blank and AutoCount has a value" could not even be counted.
#
# COLUMNAR, like ac-reconcile-truth.json.gz: 22,700 headers x ~30 mostly-empty
# fields as objects would be megabytes of repeated key names.
#
# The receipt (exportedAt / source) lives INSIDE the payload, not in
# ac-reimport-manifest.json — the same reason the stamps section gives: the
# consumer subtracts this timestamp to refuse a stale snapshot, so it is
# timezone-aware, unlike the manifest's naive NOW.
if want("hdr"):
    SO_HDR_COLS = [
        "DocNo", "DocDate", "DebtorCode", "DebtorName", "Attention", "Ref",
        "SalesAgent", "SalesLocation", "Phone1",
        "InvAddr1", "InvAddr2", "InvAddr3", "InvAddr4",
        "DeliverAddr1", "DeliverAddr2", "DeliverAddr3", "DeliverAddr4",
        "DeliverContact", "DeliverPhone1",
        "CurrencyCode", "DisplayTerm", "Cancelled",
        "Remark2", "Remark3", "Remark4", "UDF_Note", "SalesExemptionExpiryDate",
        "UDF_VENUE", "UDF_BRANDING", "UDF_PDate", "UDF_BALANCE", "UDF_PAYEMENT",
        "UDF_ToPONo", "LastModified",
    ]
    PO_HDR_COLS = [
        "DocNo", "DocDate", "CreditorCode", "CreditorName", "Ref", "Attention",
        "InvAddr1", "InvAddr2", "InvAddr3", "InvAddr4",
        "DeliverAddr1", "DeliverAddr2", "DeliverAddr3", "DeliverAddr4",
        "DeliverContact", "DeliverPhone1",
        "CurrencyCode", "DisplayTerm", "Cancelled", "LastModified",
    ]

    def hdr_rows(table, cols, name_col_source):
        # DocNo is trimmed the way every other section trims it; CreditorName is
        # the one value that comes from a JOIN rather than the header itself.
        sel = []
        for c in cols:
            if c == "DocNo":
                sel.append("LTRIM(RTRIM(h.DocNo)) AS DocNo")
            elif c == "CreditorName":
                sel.append("cr.CompanyName AS CreditorName")
            else:
                sel.append("h.%s" % c)
        join = " LEFT JOIN Creditor cr ON cr.AccNo = h.CreditorCode" if name_col_source else ""
        # NO Cancelled filter: a cancelled document the ERP migrated still needs
        # its header read, and `Cancelled` is exported so the consumer can decide.
        rows = rows_of(
            "SELECT %s FROM %s h%s WHERE %s ORDER BY h.DocNo"
            % (", ".join(sel), table, join, TEST_H)
        )
        return [[r[c] for c in cols] for r in rows]

    so_hdr = hdr_rows("SO", SO_HDR_COLS, False)
    po_hdr = hdr_rows("PO", PO_HDR_COLS, True)
    hdr_exported_at = datetime.datetime.now().astimezone().isoformat()
    write_gz("ac-doc-headers.json.gz", {"rows": {
        "exportedAt": hdr_exported_at, "source": DB,
        "so_fields": SO_HDR_COLS, "so": so_hdr,
        "po_fields": PO_HDR_COLS, "po": po_hdr,
    }})
    print("   headers: SO=%d PO=%d" % (len(so_hdr), len(po_hdr)), flush=True)

# The manifest is MERGED, never replaced. `ONLY=<section>` runs one section, and
# the sections with no reload branch (ruler, remarks, stamps, hdr) contribute
# nothing to `manifest["files"]` on such a run — so a plain rewrite DELETED
# their entries every time another section was re-cut alone. Merging keeps every
# earlier receipt and lets this run's sections overwrite only their own.
_prev = {}
try:
    with open(os.path.join(OUT, "ac-reimport-manifest.json"), "r", encoding="utf-8") as f:
        _prev = json.load(f)
except (FileNotFoundError, ValueError):
    _prev = {}
_merged = dict(_prev)
_merged.update({k: v for k, v in manifest.items() if k != "files"})
# `exported_at` names the cut the manifest's COUNTS came from. A run that
# re-cut none of them (ONLY=hdr, ONLY=stamps) must not restamp it — that would
# date every other section to a run that never touched it.
if _prev.get("exported_at") and not (set(SECTIONS_RUN) & {"so", "iv", "dates", "po1", "po2", "dos", "bal", "costs", "grrefs", "links"}):
    _merged["exported_at"] = _prev["exported_at"]
_merged["last_run"] = {"at": NOW, "sections": SECTIONS_RUN}
_files = dict(_prev.get("files") or {})
_files.update(manifest["files"])
_merged["files"] = _files
with open(os.path.join(OUT, "ac-reimport-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(_merged, f, ensure_ascii=False, indent=2)
print("\nmanifest written. NOT produced here (separate passes): ac-stock-layers.json.gz,", flush=True)
print("photo manifests, fidelity truth (run export-ac-fidelity-truth.py), live ruler (export-ac-live.py).", flush=True)
cn.close()
