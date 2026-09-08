## The reconcile counted three correct-by-design facts as differences [medium]

**Symptom.** On go-live day the owner read the reconcile's summary table and
asked about the same three cells every run, all night. Run 34178538830
(2026-09-08 10:00 Malaysia time) printed `PO price 241`, `GR money 109` and
`PO absent 1` under headings that say "difference", and its verdict line said
`634 disagreements`. None of those 342 counts was work anybody could do:

- the 241 purchase-order lines have NO price in the book at all. Houzs prices a
  purchase when the goods arrive — 10,810 of 18,890 book PODTL rows carry
  UnitPrice 0.00, and 7,591 of 9,416 purchase orders total RM 0.00 (measured
  over sqlcmd 2026-09-07). "Copying the book" would have ERASED 241 real ERP
  prices;
- 100 of the 109 goods-receipt totals are RM 0.00 in the ERP against a book
  value, which the owner ruled on the same morning: 「GR 0 没关系」;
- the 1 absent purchase order is PO-009979, about which he had already decided
  (mint an accessory for its code-less "ERGOTEX PILLOW CASE").

A number that is correct-by-design sitting under a heading that says
"difference" is a false alarm that has to be re-explained on every run, and it
inflates the backlog the owner is trying to burn down to zero.

**Root cause (traced).** The information existed; it never reached the summary.
`check-ac-erp-reconcile.mjs` already split the unit-price findings four ways
(`bookUnpriced` / `bothPriced` / `erpDropped` / `bookDropped`) and printed that
split in the PO section — but `summary.push` wrote `price: F.price.length`, the
UNSPLIT total, and `gaps` added the same unsplit total. The same shape held for
the document total: `zeroMoneyDocs` was counted and announced as "one systematic
cause", and then every one of those documents was still pushed into `F.money`
and into `gaps`. Absences had no notion of a decided-but-not-yet-executed
document at all. Observed by reading the run's own log against the code: the PO
section printed `book holds NO price, ERP does: 241 ... both sides priced and
they differ: 0`, and the summary five hundred lines later printed `price 241`.

`non-MYR` was the precedent for the right answer and it was already in the same
table: a foreign-currency document is compared in its own currency, so it gets
its OWN column and is deliberately excluded from `gaps` (ledger 0665).

**Fix.** Three counts move into three new columns — `no-price`, `ERP-RM0`,
`decided` — printed beside `non-MYR` under a header that separates DIFFERENCES
from NOT differences, each with a sentence under the table in the owner's terms,
and each excluded from the gap total. Nothing is hidden: every count is still
printed, and the reclassified documents are still listed by name.

The hazard this creates is the mirror image of `docs/bugs/0668-the-reconcile-printed-real-gaps-as-owner-decisions-for-do-iv.md`
— there a hand-typed label printed 30 real gaps as owner decisions — so no
column here is a constant that is believed. `backend/scripts/lib/ac-not-a-difference.mjs`
derives every one from a measurement made in the same run, and refuses when the
measurement is missing:

- `no-price` is refused wholesale while the EXPORT SELF-CHECK is non-zero (a
  book line stating a SubTotal over a zero UnitPrice is what a lost price looks
  like); everything stays in `price`.
- `ERP-RM0` is applied per document and only where the ERP proves it is migrated
  paperwork — `scm.grns.migrated_no_stock` true AND zero `scm.inventory_movements`
  naming the receipt. A RM 0.00 document that fails that proof is an IMPOSTOR:
  it stays a money difference and is printed louder than one. The probe fails
  soft, so an unreadable column reclassifies nothing rather than refusing the
  whole run.
- `decided` is honoured only while the entry's own stated reason still measures
  true against the book. PO-009979's reason is "every line is description-only",
  and the snapshot says `hasCode=0` on its single line ("ERGOTEX PILLOW CASE -
  FAIR", 20 @ RM 50.00, un-cancelled, 2026-08-27). An entry whose document is no
  longer absent prints STALE and is not silently dropped.

Pinned by `backend/tests/acNotADifference.test.ts` (21 tests) — total
preservation on every split including the refusal paths, the impostor guards,
and the rule that A PARTIAL COVER STILL REPORTS DIFFER (six qualifying rows out
of ten move six, never ten). **Proved RED on the unfixed tree**: with the
movements guard, the export self-check and the predicate check each stubbed out,
`4 failed | 14 passed`; restored, `21 passed`.

The test lives in `backend/tests/`, NOT next to the module in
`backend/scripts/lib/`, because eleven of the thirteen `*.test.mjs` files in
that directory are collected by no vitest project and run by no workflow —
`classifyTests()` walks only `tests/` and `src/`. A guard nobody runs is not a
guard.

**Ref.** fix/reconcile-notadiff, 2026-09-08.
