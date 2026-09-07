## qa-matrix asserted FromDocType on the SO->PO edge, which AutoCount never stamps [medium]

**Symptom.** `qa-matrix.ps1` reported `5a link PO<-SO` as **FAIL** on every run,
with the message `NO line carries a Transfer link - FromDocType='' FromDocNo=...`.
The purchase order it complained about was correct: it had been created from the
sales order by the SDK moments earlier, AutoCount's own convert-from screen
showed the link, and the `FromDocNo` in the failure message was the right sales
order. A standing red row in the QA matrix trained readers to skip it, which is
what a false failure costs.

**Root cause (traced).** `CheckLink` required BOTH `FromDocNo` and
`FromDocType` on every line of the target, and applied that rule uniformly to
all five conversions. **AutoCount does not record SO->PO the way it records the
other four.** It stores that edge as `PODTL.FromSODtlKey` plus `FromDocNo` and
leaves `FromDocType` NULL.

Measured against the live AED_HOUZS book on 2026-09-07, over the whole corpus
rather than one test document:

```
SO -> PO edge : 10792 lines name a source line (FromSODtlKey);
                0 of them also carry FromDocType.
DO <- SO      : 48677 lines name a source; 48677 carry FromDocType.
IV <- SO      : 44758 lines name a source; 44758 carry FromDocType.
IV <- DO      : 44758 lines name a source; 44758 carry FromDocType.
GR <- PO      : 18943 lines name a source; 18943 carry FromDocType.
PI <- GR      : 21480 lines name a source; 21480 carry FromDocType.
```

Zero of 10,792 on the one edge, 100% on the other five. The assertion was wrong,
not the link — and it was wrong for every SO->PO document in the book's history,
not just the QA one, so no amount of re-running or re-creating the test document
could ever have turned it green.

Also confirmed in the same measurement: `FromDocDtlKey` exists on all six detail
tables and is NULL on all 220,723 rows, so `FromSODtlKey` is the ONLY line-level
conversion key this book carries.

**Fix.** `CheckLink` takes a `-LineKeyed` switch. For the SO->PO edge it asserts
`FromDocNo` plus a resolvable `FromSODtlKey` and says in its PASS message that
the edge carries no `FromDocType` by design; the other four edges are unchanged.
`check-ac-convert-symmetry.mjs` re-proves the split from a fresh snapshot of the
whole book on every run (`assertFromDocTypeShape`) and REFUSES rather than
applying the rule if the book ever stops behaving this way, so the fix cannot
quietly rot into a new false assumption.

The prover was proved RED first: a mutant that blinds it to the split
(`poNamed.filter(() => true)`) exits 2 with
`trap-1 prover did not see the empty FromDocType on the SO->PO edge`.

**Ref.** feat/ac-convert-symmetry-2026-09-07, PR #3049, 2026-09-07.
