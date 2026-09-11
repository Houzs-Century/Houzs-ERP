## The printed purchase order showed no photo because the imported document never carried one [medium]

**Symptom.** Reported by Sim, 2026-09-11, item 22: "PO export PDF dont have
photo attach". The owner put the expectation plainly — 「正常来说，我的 SO 带去
PO，PO 那边就会带照片，照片应该要显示出来的」 and then, rejecting a read-it-live
workaround, 「我convert SOtoPO就应该带照片过去 带了照片全部documentation 就应该要
看到」.

**Root cause (traced, and it is NOT the convert).** The SO→PO carry works. A
converted line copies its source sales-order line's photo keys at convert time
(`backend/src/scm/lib/po-convert-line.ts` → `photo_urls`, from `SO_ITEM_SELECT`'s
`photo_urls` via `photoUrls: row.photo_urls ?? []` in `backend/src/scm/routes/mfg-purchase-orders.ts`),
and the print path renders them for all three entry points, which share
`renderPurchaseOrderInto` (`frontend/src/vendor/scm/lib/purchase-order-pdf.ts`). Measured
against production 2026-09-11 on the read-only DSN:

```
ERP-raised PO lines missing a key their source SO line holds: 0
```

Every line that IS missing one sits on an **AutoCount-imported** document, where
no convert ever ran. The importer attached what the BOOK had on that document,
and AutoCount often held the photograph on the sales order only — so the
imported purchase order got nothing:

```
PO: 117 lines on  83 purchase orders  carry no photo while their SO line does
DO:  68 lines on  46 delivery orders   - the same shape, mig 20260828T0746
```

All 187 keys involved are LIVE objects in R2 (`so-items/` listed through the R2
API, 0 dead), so every photograph this puts on a document actually opens.

**Two provenance traps, both of which produced a wrong answer first.**

1. **`linked_ac_docno` does NOT mean "imported".** The write-back stamps it on
   documents WE raised, so splitting on it answers a different question — it
   separates Houzs (synced) from 2990 (never synced,
   `owner-ruling-2990-does-not-sync`). The distinguisher is the document NUMBER:
   an ERP-minted one carries a YYMM block (`HC-PO-2609-081`), an imported one is
   the book's running number (`HC-PO-010148`). The first read of this claimed
   "all affected documents are imported" from the wrong column and was right by
   luck; re-measured on the number shape, it holds — 310 of 310.
2. **"Is any source key absent?" is not "is the photo missing?"** That query
   plans **310** PO lines. 193 of them already carry the BOOK's own purchase
   attachment (`po-items/.../ac-<DtlKey>-n.jpg`) while the sales order holds a
   DIFFERENT shot; nothing is invisible there, and writing them would put a
   second sketch on 149 already-received purchase orders. The defect is the
   **117** that show nothing at all.

**What this does NOT fix, and it is the bigger half.** A purchase order raised
today still prints without a photograph whenever the SALES ORDER line has none —
and that is nearly every new order. Of 872 sales-order lines on ERP-raised
documents only **8** carry a photograph; of the 359 lines added since
2026-09-01, **5**. The upload path is not broken (15 human uploads exist across
SO and PO lines, newest 2026-09-10) — it is simply not being used. No script can
supply a picture nobody took, so this is a process item for the owner, not a
code fix.

**Fix.** `backend/scripts/backfill-document-line-photos.mjs` +
`.github/workflows/backfill-document-line-photos.yml` — plan by default,
`CONFIRM="CARRY DOCUMENT PHOTOS"` to apply, fresh-connection SHAPE verification.
It fills a document line that shows NOTHING, holds the 193 mirror-shaped lines
back behind `INCLUDE_MIRROR=1` (a printing decision, the owner's), and warns
loudly if an ERP-minted document ever appears in the plan — that would mean the
live carry has started dropping photos, and repairing it quietly would hide it.

Nothing is uploaded or deleted: the R2 objects are SHARED between the documents
(mig 0274), and the read routes authorise a photo by MEMBERSHIP of the line's
`photo_urls` and never by key shape (`poItemPhotoSignedHandler`,
`backend/src/scm/routes/delivery-order-item-photos.ts`), so an `so-items/` key on a PO or DO
line is served unchanged.

The decision that matters is a pure function with the 193-line shape pinned as
the named regression case — `backend/scripts/lib/document-photo-carry.mjs`, 10 cases in
`backend/tests/documentPhotoCarry.test.mjs`. `includeMirror` is a REQUIRED
parameter, not a default, because the two answers touch different populations
(CLAUDE.md, BUG CLASS optional-param-noop).

**Ref.** `fix/po-photo-backfill`, 2026-09-11. Related:
docs/bugs/0815-a-line-s-photo-printed-photo-with-no-picture-because-the-pdf.md
(the thumb 404 fallback this depends on) and
docs/bugs/0789-a-po-line-carried-a-stale-so-photo-key-after-the-so-line-was.md
— `repair-po-carried-photos.mjs`, which re-aligns a STALE carried
key and cannot see these lines, because its candidate set requires the PO to
already carry an `so-items/` key.
