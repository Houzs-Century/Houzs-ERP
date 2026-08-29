## Sofa lines never reached bound mode — diverted to the batch pass before needs was built [high]

**Symptom.** 11 migrated sofa piece lines sat PENDING with their own converted
PO fully received, undelivered, on processed CONFIRMED orders (probe run
33233660301: SO-004725 ×3, SO-008942, SO-011008, SO-011571, SO-011733,
SO-011957 ×3 and more) — while bound mode promises exactly that shape a light.
A fresh recompute did not move them.

**Root cause (traced).** `so-stock-allocation.ts` routes every batched sofa
line into `sofaLineRecs` at needs-construction time (`isBatchedLine → continue`)
— so sofa lines never enter `needs`, and bound mode reads only `needs`
(`boundNeeds = needs.filter(...)`). The BOUND_GROUPS set names 'sofa', the
comment quotes the owner naming sofa, and the read that feeds it structurally
could never see a sofa line. The sofa set pass then requires a single dye lot
whose component multiset exactly equals the set — which balance-imported
migrated stock rarely forms — so every such set fell through to PENDING.
Bedframe was unaffected (it stays in `needs`).

**Fix.** The bound read's id set now includes `sofaLineRecs`, and the sofa set
walk consults `dedicatedReady` when no covering batch exists: per line,
`min(received, need)` lights READY/PARTIAL — the same arithmetic as bedframe,
per the owner's 2026-08-29 hard-binding re-ruling (per line, exclusive,
partial receipt = partial READY). No batch is claimed on this path; the DO
flow's operator-picks-the-batch rule covers dispatch. A covering batch still
wins and stamps `allocated_batch_no`.

Pinned by `so-stock-allocation.sofa-bound.test.ts`, proved RED on the unfixed
tree (both bound tests: expected READY/PARTIAL, received PENDING), green after,
with guards that no-dedication-no-batch stays PENDING (hard binding, not
pooled) and that a covering batch still wins.

**Ref.** fix/sofa-bound-mode, 2026-08-29.
