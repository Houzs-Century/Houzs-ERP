## The Outstanding card was bigger than the table under it [high]

**Symptom.** On `/scm/outstanding`, the **SI** module card and the SI row list
sat on the same screen and disagreed about the same money — and the card was the
larger of the two. The card is the number a person reads to decide how much is
owed.

**Root cause (traced).** #2684 made the SI ROW list net of the deposit taken on
the source Sales Order. `GET /outstanding/summary` was left on its PostgREST
aggregate, `SUM(v_si_outstanding.outstanding_sen)` — and that column is defined
as `total_sen - paid_sen`, which cannot see money banked against the ORDER. Same
page, two rules. The `?snapshot=1` fast path had the same blindness through
`scm.mv_ar_aging`.

The split of one order's deposit across its invoices depends on the invoice's
SIBLINGS, so no SQL column and no aggregate can express it.

**Fix.** `si` — and only `si` — leaves the one-request aggregate for the
paginate-and-reduce path the endpoint's own header already offered as the
correct-but-slower fallback, and applies the deposit per row through
`stampOrderDeposit`. The other six modules keep their aggregate: the rule does
not apply to them and there is no reason to make them pay for it.

**No view and no grant was touched.** Recreating a view is a NEW object with an
empty ACL — migration 0189 took the Sales Order list down for every user that
way and needed 0190 and 0191 to repair. The served FIGURE is adjusted instead.

Three properties, because each is a way the fix could be worse than the bug
(`backend/src/scm/lib/si-outstanding-summary.ts`):

- **The aggregate is the FLOOR of correctness; the scan only refines it
  downward.** The SQL number is computed first and kept. The figure is therefore
  never smaller than the truth — only equal to it, or too big and saying so.
- **The cap does not truncate.** The scan stops at 4,000 invoices; past that the
  aggregate — which counted every one of them — stands, with
  `deposit_applied: false` and a note. A summary that quietly stops counting is
  worse than one that is too big, because too big at least looks wrong.
- **A failed read is not a zero.** Every other module degrades to a zeroed
  entry; on a page about money owed, `0` reads as "nothing outstanding" and
  tells the office to stop chasing. `si` answers `unavailable: true` and the
  card prints a dash and "Could not read".

An invoice whose order could not be resolved keeps its LARGER figure, is still
counted, and flips `deposit_applied` to false with the count in the note. The
card labels such a figure "at most RM x outstanding".

**Still wrong, and not reached by this change:** the Collection Agent
(`backend/src/services/agents/collection-agent.ts:112`) and the Document Agent's
`UNPAID_SI` detector and AR-aging buckets
(`backend/src/services/agents/document-agent.ts:494`, `:652`, `:901-912`) all
compute `si.total_sen - si.paid_sen` in raw SQL. They over-state, so they
propose chasing too much. Neither file is edited here.

Pinned by `backend/src/scm/lib/si-outstanding-summary.test.ts` (12), proved RED
by deleting ten guards one at a time — ten red, including the bug itself
(dropping the subtraction fails 2).

**Ref.** `fix/the-card-and-the-rows-agree`, 2026-08-23. Follows #2684.
