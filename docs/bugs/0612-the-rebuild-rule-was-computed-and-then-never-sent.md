## The rebuild rule was computed and then never sent [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner deletes one line from a sales order AutoCount already
holds. The book keeps the line, at quantity 0, marked — exactly the symptom
`docs/bugs/0606-a-deleted-line-stayed-in-autocount-at-quantity-zero.md` opened
with, and exactly what the new rule was supposed to end.

**Root cause (traced).** The rule was right and unreachable. `composeEdit` derives
it correctly, then reads the answer in exactly ONE place in the whole file: the
branch that runs only when the document has a line carrying no AutoCount key.
`composeDetails` never reads it. The ordinary return carried no `Rebuild` field at
all, so the payload for the ordinary case — delete a line from a document whose
remaining lines are all keyed — went out as a plain keyed edit with the deleted
line appended as a retirement, which is the behaviour the rule was meant to
replace.

Found with a search for `.rebuild` over the composer: two hits, both inside the
keyless branch. The rule had a unit test, the wiring had none, and a unit test
over a rule cannot see a caller that drops the answer. Same shape as BUG CLASS
optional-param-noop — a decision that reaches nothing looks identical to a
decision nobody made.

**Fix.** `Rebuild` rides the ordinary return too, spread in from the effective
options. The retired lines still travel; the host skips them on a rebuild
(`if (rebuild && Bool(it, "Retire")) continue;`), so a rebuilt document does not
carry a blank row for a line that is gone.

**Verified.** `backend/src/scm/lib/autocount-add-delete-line.test.ts` — "deleting
a line rebuilds, even when every remaining line is keyed" — asserts on the payload
the host actually receives, not on the composer's opinion. Proven RED first
(`expected undefined to be true`), then green. 680 tests pass.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
