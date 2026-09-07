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

**Measured after the fix, on production (2026-09-07 evening, +08).** Re-seed
PLAN run 34140365685, APPLY run 34140557010, reconcile run 34140765109:

| | before (run 34135024572) | after |
|---|---|---|
| non-sofa cells compared | 996 | 996 |
| non-sofa cells disagreeing | 202 | **3** |
| units over comparable cells | AutoCount 9,916 vs ERP 9,606 | AutoCount 9,916 vs ERP **9,916** |
| value at risk, non-sofa | RM 19,666.98 (177 cells uncosted) | **RM 0.00** (0 of 3 costed) |
| sofa cells compared | 0 | **41** (3 agree, 38 disagree) |
| migrated documents that wrote stock | not measured | **0** |

The 3 that remain are ERP display products no AutoCount item maps to, so
AutoCount states no opinion on them and the re-seed left them alone by design.

The safety check ran before the overwrite and found **0** stock movements that
exist only in the ERP since seeding, on both readings (after the seeding's own
last movement, and since 2026-08-29 00:00 (+08)). The ~22h baseline bias the
README recorded as unquantified measured **47 cells / 128 units**.

Sofa's first-ever number: AutoCount 107 whole sofas vs the ERP's 49, over 48
builds. 24 of the 58 missing sit at BALAKONG DISPLAY, where the ERP holds no
sofa at all — those are the showroom display units `import-ac-sofa-stock.mjs`
deliberately refuses to create ("no PO, no configuration"), now counted rather
than assumed. Sofa value at risk RM 50,147.23, still a LOWER BOUND at 9 of 38
cells costed.
