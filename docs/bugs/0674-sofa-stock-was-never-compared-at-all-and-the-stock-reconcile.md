## Sofa stock was never compared at all, and the stock reconcile's biggest bucket was snapshot age [high]

**Symptom.** Two separate readings of the same report, on the eve of the Company 1
go-live. `Stock vs AutoCount reconcile (read-only)` run 34135024572 compared 996
item x warehouse cells and reported 202 disagreeing, the largest bucket being
**157 cells / 410 units "ERP IS BEHIND THE BOOK"**. And SOFA — the highest-value
category the business sells — contributed **zero** cells to that comparison: it
was held out on both sides, so nobody could say whether the ERP's sofa stock
agreed with the book or not. The owner was being shown a stock report with a hole
in the middle of it and a headline number that read as 202 defects.

**Root cause (traced).** Two causes, one report.

1. **The 157 cells were not a defect, they were the snapshot's age.**
   `.github/workflows/create-migrated-documents.yml` says so in its own header:
   the migrated goods receipts and delivery notes are stamped `migrated_no_stock`
   and write NO inventory movement, because *"the balance snapshot already counts
   those receipts as IN and those deliveries as OUT, so posting either would apply
   the same movement twice."* ERP stock is therefore a BALANCE SNAPSHOT, not a
   ledger replay, and a snapshot has exactly one defect mode: age. That snapshot
   was taken 2026-08-28 23:27 (+08); the cause string the reconcile prints for
   those cells — "the ERP still holds exactly the seeded quantity; AutoCount has
   traded this cell since seeding" — is a description of elapsed time.

2. **Sofa was excluded because folding was never attempted, only decomposing.**
   `check-stock-vs-autocount.mjs` held sofa out on both sides with a correct
   reason — AutoCount counts one whole sofa where the ERP counts its
   compartments — and `import-ac-stock-balance.mjs` refuses to decompose a
   balance row for a correct reason too: a balance row carries a quantity and
   nothing else (0 of 1,337 sofa GRDTL lines in AED_HOUZS carry a serial or a
   batch), so splitting one into compartments would invent which build it is.
   But the OTHER direction was always available and nobody had taken it:
   `import-ac-sofa-stock.mjs` stamps every compartment lot of one build with the
   same `batch_no` = its source PO number — the identity `grns.ts`
   `resolvePoBatchByItem` writes (mig 0120) and `sofa-set-coverage.ts` documents.
   **batch = build**, so pieces fold up with no invention at all.

**Fix.**

- `backend/scripts/reseed-stock-from-ac-snapshot.mjs` + its workflow re-seed the
  balance from the 2026-09-07 22:21 (+08) snapshot, copying AutoCount's quantity
  and never computing one. It carries the four release-discipline parts
  (`audit:release-discipline` reports *No new violations*), refuses to apply while
  any ERP-only movement exists since seeding, dumps the pre-overwrite balance
  off-database first, and verifies on a fresh connection that every governed cell
  equals AutoCount AND that nothing outside the governed set moved.
- `backend/scripts/lib/sofa-piece-fold.mjs` folds ERP compartments into whole
  sofas per model + warehouse, pinned by `backend/tests/sofaPieceFold.test.ts`
  (15 tests). The fold rule is MIN across the build's distinct compartment SKUs —
  a sofa is only whole while every piece is still on the shelf — and the MAX is
  returned beside it so uneven builds are reported rather than hidden.
  `check-stock-vs-autocount.mjs` gains PART A2, which compares sofa for the first
  time. **Proved RED on the unfixed tree** in the sense that matters here: on
  `main` the sofa comparison does not exist, so the count of sofa cells compared
  is 0 and no assertion about sofa stock is possible.
- The fold is comparison-only. Sofa stock storage stays piece-level, because the
  sofa MRP (`sofa-set-coverage.ts` `findCoveringBatch`) is hard-bound to it —
  owner ruling, same night.

**Ref.** fix/stock-reseed-golive, 2026-09-07.
