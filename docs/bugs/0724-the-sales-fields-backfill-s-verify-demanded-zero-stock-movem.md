## The sales-fields backfill's verify demanded zero stock movements on documents that legitimately have them [low]

<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- status: fixed -->

**Symptom.** `backfill-migrated-do-sales-fields.mjs` run with `scope=all` and
`mode=apply` — [`34237593431`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34237593431)
(company 1) and [`34237682845`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34237682845)
(company 2) — reported `failure`. The apply itself was right on both:
`values not as planned 0 · still NULL 0`. What tripped was the last line of the
fresh-connection verify: `inventory movements on these documents 49` and `73`.

**Root cause (traced).** The verify was copied from
`backfill-migrated-do-warehouse.mjs`, whose population is migrated documents
only, and carried that population's invariant — a migrated DO has NO inventory
movement, because the balance snapshot already counted its units — as if it
held for every document. `scope=all` is the option that reaches documents a
person raised in the ERP, and those SHIP stock: 49 and 73 movements are the
correct number for 12 and 35 delivered orders. The assertion was measuring the
right thing on the wrong set, and the `bad()` it reached exits 2 AFTER the
transaction committed, so the run went red over data that was already correct.

**Fix.** The movement count joins `scm.delivery_orders` and counts only rows
with `migrated_no_stock = true` — the invariant on the population it belongs
to. The log line says so (`inventory movements on the MIGRATED documents among
them`). Nothing about the plan, the write or the value comparison changed.

**Lesson.** A verify copied from a sibling script carries the sibling's
population assumptions. When a scope option widens the population, every
invariant in the verify has to be re-read against the widest scope, not the
default one.

**Ref.** `fix/do-sales-fields-form-and-verify-0908`, 2026-09-08. The script:
docs/bugs/0716.
