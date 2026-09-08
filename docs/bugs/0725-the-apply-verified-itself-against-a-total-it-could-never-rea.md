## The apply verified itself against a total it could never reach, and the chain report printed a rival differ count [medium]

**Symptom.** Two defects, both surfaced by the first production apply of the
`docs/bugs/0723` fix, and both the SAME shape as the bug they follow — a
measurement graded against the wrong number.

1. Apply run `34244662639` wrote 47 lines cleanly and then printed, as an
   `##[error]`:

   ```
   PI-006028: our source line(s) now sum to RM 2,072.00, AutoCount billed RM 3,738.00 — THESE DISAGREE
   PI-006200: our source line(s) now sum to RM 1,721.00, AutoCount billed RM 11,038.00 — THESE DISAGREE
   PI-006206: our source line(s) now sum to RM 2,300.00, AutoCount billed RM 3,356.00 — THESE DISAGREE
   ```

   Nothing was wrong with any of those writes.

2. `check-po-gr-pi-chain.mjs`, on run `34244418469`, printed
   **"167 (receipt x purchase order) pair(s) differ on at least one LINE"** while
   the tally for the same corpus on the same day said the goods receipts differ
   on **10**.

**Root cause (traced).**

1. `docs/bugs/0723` fixed the GATE to compare against the book's own money for
   the (receipt x order) pairs the ERP holds, and left the POST-APPLY
   VERIFICATION comparing `total === a.acTotal` — the whole invoice. A partial
   mirror can never reach that, by construction: `PI-006028`'s remaining
   RM 1,666.00 is on `GR-004015|PO-007044`, a pair the migration never carried.
   A verify that computes a different number from the one the decision was made
   on reports defects that are its own — `docs/bugs/0594`, and here it did it
   three times in one run, in red, on writes that were correct.

2. The chain report applies NONE of the owner's rulings, by design, so that a
   named document can be read line by line: 「GR 0 没关系」, 空白不覆盖 and the
   sofa decomposition are all excluded from the reconcile's count and included
   in the report's. Both numbers were true of different questions, and neither
   was an answer. That is the two-implementations-of-`different` hazard
   `check-ac-erp-reconcile.mjs` warns about in its own header twice and that
   `docs/bugs/0689` cost 40 wrong findings for; the report shipped it in the
   very PR that fixed an instance of it.

**Fix.**

1. The verification now uses the same `invoiceGateVerdict` figure the gate
   decided on (`a.expected`), and prints the out-of-scope remainder beside it —
   so the line reads "the book states X for the pair(s) we hold (the invoice
   bills Y in all; Z of it is on order(s) never migrated)". A delivery order has
   no (receipt x order) pair, so its whole-document comparison is unchanged.

2. The chain report's count is labelled a RAW OBSERVATION COUNT that must never
   be quoted as a differ count; the reason it is larger than the tally's is
   printed beside it; and `DOCS=HC-GR-xxx,HC-GR-yyy` focuses it on the documents
   the tally actually named, which is how it is meant to be read.

**NOT proved red on a live apply.** The verification fix corrects a run that has
already happened, and re-running it is a no-op because every line it would touch
is now priced — so the corrected sentence has not been observed in production.
**UNTESTED there.** What IS pinned is the arithmetic it now quotes:
`backend/tests/acChainLineGrain.test.mjs`, 21 cases, whose four defect cases were
proved red against the old whole-invoice rule before `ac-chain-line-grain.mjs`
was written.

**Ref.** `fix/gr-line-align`, #3307, 2026-09-08.
