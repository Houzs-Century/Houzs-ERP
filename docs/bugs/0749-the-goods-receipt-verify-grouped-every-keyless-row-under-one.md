## The goods-receipt verify grouped every keyless row under one empty key [medium]

**Symptom.** `repair-gr-money-from-book` MODE=apply, run 34318963216, exited 3:

```
APPLIED, BUT THE VERIFY FAILED on 6 assertion(s):
   HC-GR-005363: line AKEMI BASTION MATT (Q) key  names no book line
   HC-GR-005363: header RM 3525.00 against the book's own lines summing RM 1950.00
   ... the same two for HC-GR-005367 and HC-GR-005368
```

**The write was right and the assertion was wrong**, which is the worse of the
two ways round — the same shape `docs/bugs/0738` records, and the reason that
file already says an apply exiting non-zero on a correct write teaches its next
reader to ignore the exit code. Proved independently, `probe-book-line-gaps` run
34319461806 on a fresh read-only connection:

```
HC-GR-005363  total_sen 352500  = 78750 + 97500 + 97500 + 78750   (book netTotal 352500)
HC-GR-005367  total_sen 157500  = 78750 + 78750                   (book netTotal 157500)
HC-GR-005368  total_sen 125850  = 62925 + 62925                   (book netTotal 125850)
```

Every `discount_sen` is the gap the book itself states. Production is correct.

**Root cause (traced).** The keyless money arm added the same day prices a row
the book FORCES the money for without stamping a line key onto it. The verifier
grouped the receipt's rows by `grn_items.linked_ac_dtlkey`, so every keyless row
landed in ONE group under `""`, `bookLine("")` resolved to nothing, and the
header sum counted only the rows that DO carry a key — 975 + 975 = RM 1,950.00
against a header of RM 3,525.00.

A second defect the new test found before production did: `forceKeylessMoney`
assigned every row in a bucket to `cand[0]`, so both `AKEMI BASTION MATT (Q)`
rows named book row 926907 and 926909 was named by nobody. The money is identical
either way — that is what made the bucket forced — but a book row claimed twice
would have made the verifier group two rows under one book line, where one of
them must then be zero.

**Fix.** Each planned row carries `bookDtlKey`, the BOOK's key for the row its
money came from, and the verifier groups on the ERP row's own key where it has
one and on `bookDtlKey` where it does not. The lookup is still `bookLine(...)`,
so the verification still re-derives from the account book and never from the
plan's own arithmetic. `forceKeylessMoney` now pairs one-to-one.

Both are pinned: `every keyless row names a DIFFERENT book row, so the verifier
can group them apart` failed 3 !== 4 on the unfixed assignment and passes now —
`node --test backend/scripts/lib/gr-money-from-book.test.mjs`, pass 24 / fail 0.

**Ref.** fix/book-line-inserts, 2026-09-09.
