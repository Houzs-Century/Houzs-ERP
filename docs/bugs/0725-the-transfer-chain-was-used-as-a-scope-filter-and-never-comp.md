## The transfer chain was used as a scope filter and never compared [high]

**Symptom.** The owner, 2026-09-08: 「SO PO GR PI SI DO 等等？都解决了吗？ 然后
transfer from和transfer to？」 Every tally report in front of him — the sales-order
verdict, the purchase-order and goods-receipt verdicts — could say a document
TALLIED while its lines pointed at the wrong source document, or carried a
transferred quantity the account book disagrees with. Nothing would have said a
word.

**Root cause (traced).** `check-ac-erp-reconcile.mjs` reads `transferedQty`,
`fromDocType` and `fromDocNo` — but ONLY to decide SCOPE. Its own header states
the rule it uses them for ("outstanding = `Qty > TransferedQty`, and NOT invoiced
direct"), and the reads are at `:329` and `:334`. Downstream,
`LOCKING_AXES` in `scripts/lib/so-verdict-derive.mjs` held document presence,
line count, item code, quantity, unit price, document total, currency and the
variant axes — and **no member for where a line came from, and none for how much
of it has been transferred on**. So the chain was a FILTER and never a
COMPARISON, and `bucketOf` had nothing to bucket.

That is this repo's own named class — one column carrying several populations —
and it was found by the owner asking, not by a gate.

Three cross-system checkers DID exist and none of them closes it, which is why
it survived: `check-ac-convert-symmetry.mjs` measures the edge at document-PAIR
grain and prints global counts, and `check-ac-transfer-counters.mjs` compares the
stored counters. Neither produces a PER-DOCUMENT verdict, so neither could ever
lock a document or change a tally answer.

**What the account book can and cannot answer, measured rather than assumed**
(`node -e` over the committed `backend/scripts/data/ac-convert-edges.json.gz`,
2026-09-07 cut, 220,723 detail rows):

| type | lines | `FromDocNo` set | `FromSODtlKey` set | `FromDocType` set | `FromDocDtlKey` set |
| --- | --- | --- | --- | --- | --- |
| SO | 62,732 | 0 | 0 | 0 | **0** |
| PO | 18,890 | 10,291 | 10,792 | **0** | **0** |
| GR | 21,746 | 18,943 | 0 | 18,943 | **0** |
| DO | 48,772 | 48,677 | 0 | 48,677 | **0** |
| IV | 45,950 | 44,758 | 0 | 44,758 | **0** |
| PI | 22,633 | 21,480 | 0 | 21,480 | **0** |

`FromDocDtlKey` is empty on every row of all six detail tables, so **the source
LINE is answerable on ONE edge only** — SO→PO, which AutoCount records
differently as `FromSODtlKey`. On the other four the book states a source
DOCUMENT and nothing finer. And `PODTL.FromDocType` is empty on all 18,890 rows
while `FromDocNo` is set on 10,291, so a checker that tests the TYPE reports
every purchase order in the book as sourceless.

**Fix.** The chain is now an AXIS in the verdict every report already reads,
never a second opinion beside it:

- `scripts/lib/transfer-chain-verdict.mjs` — the PURE classifier for the FROM
  half, and it RE-EXPORTS the TO half's rule from
  `scripts/lib/transfer-counter-verdict.mjs` rather than restating it, so the
  counter comparison is the same function `check-ac-transfer-counters.mjs`
  calls.
- `scripts/lib/ac-transfer-chain-run.mjs` — the reads. It may only write onto a
  document the run already COMPARED (`recorder.forType(t)`), because
  `record()` creates an entry it has never seen and a created entry would move
  the population `lib/tally-crosscheck.mjs` sets the two instruments against.
  It FAILS SOFT: a missing or stale chain snapshot records nothing and says so.
- `LOCKING_AXES` gains `transfer from` and `transfer to`; `UNANSWERABLE_AXES`
  gains `transfer chain not verifiable`. `bucketOf` and `isTallied` are
  untouched, and adding the axis cannot change what TALLIED means.
- Three NOTE classes carry the silences so none of them reads as agreement:
  `chain-line-not-in-book` (the book records no source line on this edge),
  `chain-no-source` (the head of a chain) and `chain-no-erp-counter` (SO→DO and
  DO→IV store no ceiling — delivery is computed live).
- `DOC_TYPES` gains DO, IV and PI. `docTypeSpec` THREW for those three, so no
  report could be asked for half the types the owner named.

**Proved RED on the unfixed tree, three ways**, each watched to fail before the
code existed: the classifier suite against an absent module; a mutant that
reports document agreement as LINE agreement (5 failures); a mutant that
requires `FromDocType` to believe a source — the `qa-matrix.ps1` bug — (8
failures); and, for `tests/transferChainAxis.test.mjs`, removing the two names
from `LOCKING_AXES`, which makes `record()` a silent no-op and turns a wrong
source document back into a clean document (4 failures, including "a wrong
source document is WORK").

**Ref.** `feat/ac-transfer-chain-axis`, 2026-09-08.
