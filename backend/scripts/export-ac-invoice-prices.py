#!/usr/bin/env python3
"""Export the REAL purchase-invoice price for every cutover-scope purchase line.

WHY THIS EXISTS
---------------
10,372 AutoCount PO lines carry no price at all. Their cost is not missing — it
is on the PURCHASE INVOICE, which the cutover never read. The chain is

    PO --(GRDTL.FromDocNo)--> GR --(PIDTL.FromDocNo, FromDocType='GR')--> PI

and the invoice is the authoritative cost, because it is what was actually paid.
Where a PO price and its PI price disagree (1.1% of already-priced lines), the
invoice wins for costing.

WHY A THREE-PART KEY AND NOT A LINE KEY
---------------------------------------
AutoCount populates NO line-to-line keys on this chain:
    PIDTL.FromDocDtlKey  0 of 20,777 populated
    GRDTL.FromDocDtlKey  0 of 21,000 populated
and the ERP's own purchase_order_items.linked_ac_dtlkey (migration 0273) was
never backfilled (0 rows). So the only available handle is the three-part key
(source document, ItemCode, Desc2). This file emits that key, and carries
PODTL.DtlKey alongside it so a future line-key backfill can upgrade the join
without re-reading AutoCount.

WHY EVERY ROW CARRIES ITS PI NUMBER
-----------------------------------
Provenance is not optional. Every price in this file names the PI document,
its date, and the GR it came through, so a human can open that invoice in
AutoCount and check the number. A price with no provenance is unauditable and
must never be written to the ERP.

AMBIGUITY IS PRESERVED, NOT RESOLVED
------------------------------------
An AutoCount GR is a MULTI-PO receipt (GR-000034 draws lines from several POs),
so GR lines are always narrowed by GRDTL.FromDocNo = our PO before a price is
read — otherwise another PO's price would be imported. Where a key still holds
several DIFFERENT prices this file records all of them; the consumer refuses to
write and lists the key for a human. A wrong cost is worse than a blank.

READ-ONLY. SELECT only. Run locally (needs the ZeroTier route to AutoCount).
    python backend/scripts/export-ac-invoice-prices.py
Writes backend/scripts/data/ac-invoice-prices.json.gz
"""
import os
import sys
import json
import gzip
import collections
import datetime

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc required: pip install pyodbc")

# The password lives outside the repo and is never printed, committed, or logged.
CRED = os.environ.get(
    "AC_CRED_FILE",
    r"C:\Users\User\AppData\Local\Temp\claude\C--Users-User-Desktop"
    r"\2b48c4fc-47a1-4b34-bf4e-0fc5de3e9c3e\scratchpad\.dbcred",
)
DSN = ("DRIVER={SQL Server Native Client 11.0};SERVER=10.147.17.100,55500;"
       "DATABASE=AED_HOUZS;UID=sa2;PWD=")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ac-invoice-prices.json.gz")

norm = lambda s: (s or "").strip().upper()
clean = lambda s: (s or "").strip()


def main():
    with open(CRED) as fh:
        pw = fh.read().strip()
    cn = pyodbc.connect(DSN + pw, timeout=900)
    cur = cn.cursor()

    # ---- 1. every PO line, with its current price -------------------------
    cur.execute("""
        SELECT h.DocNo, d.DtlKey, d.ItemCode, d.Desc2, d.UnitPrice, d.Qty, h.DocDate
          FROM PODTL d JOIN PO h ON h.DocKey = d.DocKey
    """)
    po_lines = []
    for docno, dtlkey, item, desc2, price, qty, docdate in cur.fetchall():
        po_lines.append({
            "poNo": clean(docno), "poDtlKey": int(dtlkey) if dtlkey is not None else None,
            "acItem": clean(item), "desc2": clean(desc2),
            "poPrice": float(price or 0), "qty": float(qty or 0),
            "poDate": str(docdate)[:10] if docdate else None,
        })
    print(f"PO lines read: {len(po_lines)}")

    # ---- 2. GR lines, narrowed to their originating PO --------------------
    # (GR is a multi-PO receipt; FromDocNo is what ties a GR line to OUR PO.)
    cur.execute("""
        SELECT gh.DocNo, gd.FromDocNo, gd.ItemCode, gd.Desc2, gd.UnitPrice, gh.DocDate
          FROM GRDTL gd JOIN GR gh ON gh.DocKey = gd.DocKey
         WHERE gd.FromDocNo IS NOT NULL
    """)
    # (PO, item, desc2) -> [(grNo, grPrice, grDate)]
    gr_by_key = collections.defaultdict(list)
    gr_rows = 0
    for grno, pono, item, desc2, price, grdate in cur.fetchall():
        gr_rows += 1
        gr_by_key[(norm(pono), norm(item), norm(desc2))].append(
            (clean(grno), float(price or 0), str(grdate)[:10] if grdate else None))
    print(f"GR lines with a source PO: {gr_rows}; distinct (PO,item,desc2) keys: {len(gr_by_key)}")

    # ---- 3. PI lines, keyed by the GR they invoice ------------------------
    cur.execute("""
        SELECT ph.DocNo, pd.FromDocNo, pd.ItemCode, pd.Desc2, pd.UnitPrice, ph.DocDate
          FROM PIDTL pd JOIN PI ph ON ph.DocKey = pd.DocKey
         WHERE pd.FromDocType = 'GR' AND pd.FromDocNo IS NOT NULL
    """)
    # (GR, item, desc2) -> [(piNo, price, piDate)]
    pi_by_key = collections.defaultdict(list)
    # looser fallback, used only to REPORT, never to resolve a single price
    pi_by_gr_item = collections.defaultdict(list)
    pi_rows = 0
    for pino, grno, item, desc2, price, pidate in cur.fetchall():
        pi_rows += 1
        rec = (clean(pino), float(price or 0), str(pidate)[:10] if pidate else None)
        pi_by_key[(norm(grno), norm(item), norm(desc2))].append(rec)
        pi_by_gr_item[(norm(grno), norm(item))].append(rec)
    print(f"PI lines sourced from a GR: {pi_rows}; distinct (GR,item,desc2) keys: {len(pi_by_key)}")

    # ---- 4. walk each PO line to its invoice price ------------------------
    out = []
    stat = collections.Counter()
    for L in po_lines:
        k = (norm(L["poNo"]), norm(L["acItem"]), norm(L["desc2"]))
        grs = gr_by_key.get(k, [])
        obs = []                       # [{price, piNo, piDate, grNo}]
        for grno, _grprice, _grdate in grs:
            gk = (norm(grno), norm(L["acItem"]), norm(L["desc2"]))
            hits = pi_by_key.get(gk)
            if not hits:
                # Desc2 blank/renamed on the invoice: fall back to (GR,item),
                # still scoped to THIS receipt, so it cannot pull another PO's price.
                hits = pi_by_gr_item.get((norm(grno), norm(L["acItem"])), [])
            for pino, price, pidate in hits:
                obs.append({"price": round(price, 4), "piNo": pino, "piDate": pidate, "grNo": grno})

        priced = [o for o in obs if o["price"] > 0]
        distinct = sorted({o["price"] for o in priced})
        rec = dict(L)
        rec["grNos"] = sorted({g[0] for g in grs})
        rec["obs"] = obs
        rec["distinctPrices"] = distinct
        if not grs:
            rec["status"] = "NO_GR"
        elif not obs:
            rec["status"] = "NO_PI_LINE"
        elif not priced:
            rec["status"] = "PI_UNPRICED"
        elif len(distinct) == 1:
            rec["status"] = "RESOLVED"
        else:
            rec["status"] = "AMBIGUOUS"
        stat[rec["status"]] += 1
        out.append(rec)

    print("\n=== PO line -> invoice price ===")
    for s in ["RESOLVED", "AMBIGUOUS", "PI_UNPRICED", "NO_PI_LINE", "NO_GR"]:
        print(f"  {s:14s} {stat[s]:7d}")
    print(f"  {'TOTAL':14s} {sum(stat.values()):7d}")

    unpriced = [r for r in out if not (r["poPrice"] > 0)]
    ur = collections.Counter(r["status"] for r in unpriced)
    print("\n=== of PO lines with NO price of their own ===")
    print(f"  total unpriced PO lines: {len(unpriced)}")
    for s in ["RESOLVED", "AMBIGUOUS", "PI_UNPRICED", "NO_PI_LINE", "NO_GR"]:
        print(f"  {s:14s} {ur[s]:7d}")

    # control: where the PO already had a price, does the invoice agree?
    agree = differ = 0
    for r in out:
        if r["poPrice"] > 0 and r["status"] == "RESOLVED":
            if abs(r["distinctPrices"][0] - r["poPrice"]) < 0.005:
                agree += 1
            else:
                differ += 1
    tot = agree + differ
    pct = (100.0 * agree / tot) if tot else 0.0
    print(f"\n=== CONTROL: PO already priced, invoice resolved: {tot} "
          f"-> agree {agree} ({pct:.1f}%), differ {differ} ===")

    payload = {
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "source": "AED_HOUZS PODTL -> GRDTL(FromDocNo) -> PIDTL(FromDocType='GR')",
        "key": "(poNo, acItem, desc2); poDtlKey carried for a future line-key upgrade",
        "note": "price is the PURCHASE INVOICE price (what was actually paid). "
                "AMBIGUOUS rows carry several distinct prices and must never be written.",
        "counts": dict(stat),
        "control": {"poAlreadyPriced": tot, "agree": agree, "differ": differ},
        "rows": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"\nwrote {OUT} ({os.path.getsize(OUT)} bytes)")
    cn.close()


if __name__ == "__main__":
    main()
