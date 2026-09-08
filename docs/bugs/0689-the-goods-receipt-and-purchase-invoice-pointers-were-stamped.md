## the goods-receipt and purchase-invoice pointers were stamped from the OUTSTANDING cut, so a closed purchase order lost its receipts [medium]

**Symptom.** The convert symmetry matrix (`docs/transaction-flow-tally.md`,
re-measured 2026-09-08 10:52 local, run
[`34181536566`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34181536566))
read two edges short in the forward direction and clean in the backward one:

| edge | forward | backward |
|---|---|---|
| `GR <- PO` | 497 of 521 — **24 missing**, all dated 2026-08-28 .. 2026-09-07 | 497 of 497 |
| `PI <- GR` (composed) | 394 of 448 — **54 missing**, dated 2026-01-16 .. 2026-09-02 | 394 of 394 |

The receipt set looked like a backlog and the invoice set explicitly did not —
the tally recorded the 54 as *"NOT a backlog shape. UNKNOWN cause."* Re-running
the stamp lane was the obvious remedy and it had already been run, successfully,
at 2026-09-07 23:51 local (run `34140454809`), with no effect on either number.

**Root cause (traced).** `stamp-ac-grn-refs.mjs` read
`backend/scripts/data/ac-gr-refs.json.gz`. That file is cut by
`export-ac-reimport.py:349` with

```sql
WHERE LTRIM(RTRIM(po.DocNo)) IN ('{pokeys}')
```

where `pokeys` is `po1 + po2` — the purchase orders being exported, i.e. the
ones **outstanding on the day of that cut** (`export-ac-reimport.py:316`). The
ERP keeps an imported purchase order forever; the cut does not keep its
receipts. So the moment AutoCount finishes receiving an order, that order leaves
the outstanding population and every receipt and purchase invoice on it becomes
invisible to this job — permanently, however often it runs.

Two observations pin it, both offline against the committed snapshots:

1. `backend/scripts/data/ac-reimport-manifest.json` records
   `"exported_at": "2026-09-08 08:00:18"` but `"last_run": {"sections": ["hdr"]}`.
   Only the header section was re-cut; every other file, `ac-gr-refs.json.gz`
   included, is still the `reimport-v3 2026-08-28` round. `export-ac-reimport.py`
   writes the manifest count for a skipped section from `reload_gz()`, so the
   manifest reports a row count for a file it did not re-export.
2. Of the 28 purchase orders named in the two missing lists, **23 are absent
   from the current `ac-outstanding-po.json.gz` + `ac-so-linked-pos.json.gz`,
   and absent from `ac-gr-refs.json.gz` for exactly that reason.** The file
   carries 214 receipt documents and 186 purchase invoices; the book records
   521 in-scope receipt edges and 448 in-scope invoice edges for the same
   purchase orders.

The remaining 5 (`PO-007176`, `PO-009081`, `PO-009160`, `PO-009544`,
`PO-009702`) ARE in the cut and still short their invoices — `PO-009081` has
five purchase invoices in the book (`PI-007447`, `-007540`, `-007571`,
`-007576`, `-007577`) and two in `ac-gr-refs`. Every one of the dropped invoice
lines names the receipt and carries an item code that matches a receipt line, so
the item-code join is not what dropped them; what dropped them is UNKNOWN and is
not guessed here, because the fix does not go through that file at all.

**This also explains the shape that ruled a backlog out.** The 54 invoices are
spread across nine months, which is what made them look like something other
than a stale cut. They are not spread by cause: membership is decided by whether
the invoice's PURCHASE ORDER was still outstanding on 2026-08-28, and when an
order leaves that population its whole invoice history leaves with it, whatever
the dates on it. The dates were never the signal.

**Fix.** `stamp-ac-grn-refs.mjs` now sources both lists from
`ac-convert-edges.json.gz` — the same live book, cut 2026-09-07 16:39 local,
**unfiltered**: every `GRDTL` line naming a purchase order, and every `PIDTL`
line naming one of those receipts, composed through the receipt exactly the way
`check-ac-convert-symmetry.mjs` composes it, so what this writes is what that
reads. Cancelled documents on either end are excluded. The job now REFUSES on a
snapshot older than `MAX_SNAPSHOT_AGE_DAYS` (default 3) instead of stamping a
stale book, which is the check that would have caught this class on the day.

Writes are a **UNION**: an existing stamp is added to, never replaced. Anything
held that the book does not record is printed and left alone — deciding a
standing stamp is wrong is a different question with a different blast radius.

Proved RED on the unfixed tree, offline: the extracted `bookEdges()` over the
committed snapshot yields `PO-009741 -> GR-005322`, `PO-009081 -> PI-007447,
PI-007540, PI-007576` and `PO-007176 -> PI-006004` — four of the edges the
matrix reports missing — none of which `ac-gr-refs.json.gz` contains. Its
totals (11,620 `GR<-PO`, 11,539 composed `PI<-PO`) match the checker's
(11,623 and 11,543) exactly once the 3 and 4 cancelled-document edges the
checker counts before skipping are allowed for.

**Neither column moves anything.** `linked_ac_grn_docnos` and
`linked_ac_pinv_docnos` appear in `backend/src` only inside comments
(`autocount-outbox.ts:1069,1080,1099`, `autocount-outbox-status.ts:245`) — no
read on the Worker request path, so no stock, no readiness, no money.

**Left to the goods-receipt lane, deliberately.**
`create-migrated-documents.mjs` (KIND=grn) decides what receipts to create from
`linked_ac_grn_docnos`, so a longer list means a longer plan next time it runs.
That job was not run here and the added count is printed by the stamp so whoever
owns it decides with a number rather than a surprise.

**Ref.** fix/close-flow-gaps, 2026-09-08.
