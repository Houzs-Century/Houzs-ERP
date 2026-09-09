## Three of the differing sales orders are ones the ERP raised itself, compared against our own write-back [medium]

**Symptom.** The sales-order tally went from **18 differ** on run
[34301296779](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34301296779)
(01:58Z) to **19 differ** on run
[34303762513](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34303762513)
(02:35Z), thirty-seven minutes later, against the same book cut and the same
`main`. Nothing was merged in between. A number the owner has been reading for
two days moved while he was reading it.

**What moved.** A new row appeared in a column that had been empty all week:

```
THIS VERDICT COVERS 2,889 document(s): 2,888 present on both sides and compared
line by line, 0 in scope and absent from the ERP, 1 the ERP claims and the book
does not have.

PHANTOM  HC-SO-2609-006 — the ERP claims an account-book number the book does
not have.
```

**Root cause (traced). The tally is comparing the ERP against a copy of
itself.** `check-ac-erp-reconcile.mjs` compares every ERP sales order carrying a
`linked_ac_docno`, and its purpose is to prove the CUTOVER carried AutoCount's
own orders across faithfully — AutoCount being the independent source.

That is not true of every document it compares. Three of the nineteen were
raised BY THE ERP after go-live and reach the account book only because our own
ERP→AutoCount write-back put them there:

| document | axis | what the book holds |
| --- | --- | --- |
| `HC-SO-2609-002` | item code | 8 lines, raised 2026-09-08 |
| `HC-SO-2609-005` | leg height | 9 lines, raised 2026-09-08 |
| `HC-SO-2609-006` | **the document itself** | nothing — the write-back has not reached it |

So the "book" side of those three comparisons is OUR OWN OUTPUT. A difference on
one is a fidelity gap in the write-back, which the owner ruled out of scope on
2026-09-08 — 「写回autocount的你不需要理了」 — and it is not evidence about the
migration in either direction. `HC-SO-2609-006` is worse than that: it is
counted as a DIFFERENCE for the single reason that the write-back has not caught
up, so **the number cannot sit still while the shop is trading.** Every order
raised today enters the tally as a phantom and leaves it when the write-back
lands.

**The two book strings, read off the committed cut
`backend/scripts/data/ac-reconcile-truth.json.gz`**, which is what makes the
"our own output" claim checkable rather than a story — both are Desc2 our own
composer wrote:

```
HC-SO-2609-002 dtl 927490  HOK-1003 (A) (Q)
   "PC151-13 / DIVAN 8\" + NO LEG / GAP 12\" / T.Heights 20\""
HC-SO-2609-005 dtl 927503  HOK-1005 (Q)
   "PC151-10 / DIVAN 10\" + NO LEG / GAP 10\" / T.Heights 20\""
```

Run locally against `scripts/lib/parse-bedframe.mjs`, both decode cleanly —
`{divan:10, gap:10, leg:0, legPending:false}` — so the READER is not the
problem here and this is not another instance of `docs/bugs/0732`. Whatever the
leg-height and item-code differences turn out to be, they are between the ERP and
a document the ERP itself dictated.

**The test that separates them, and why it cannot be widened.** A migrated order
carries AutoCount's number in `linked_ac_docno` (`SO-013503`) beside its own
(`HC-SO-013503`) and the two are never equal. An ERP-raised one was given its
number by the ERP, and the write-back sent that same string to AutoCount, so both
sides read `HC-SO-2609-002`. **`linked_ac_docno === doc_no` is a property a
migrated document cannot have** — which is the same standard
`splitUnmigratedOnwardTransfer` is held to in `scripts/lib/ac-not-a-difference.mjs`:
a bucket is only worth as much as the thing keeping impostors out of it.

`scripts/lib/so-document-provenance.mjs` is that predicate, pure and tested.

**Proved RED first.** Against a stub returning `MIGRATED` for everything — which
is what the reconcile effectively assumes today —
`backend/tests/soDocumentProvenance.test.mjs` ran **`3 failed | 2 passed (5)`**.
The three failures are the cases the class exists for. With the real predicate:
**`5 passed (5)`**. The suite includes a case that must REFUSE a widening —
`{docNo: "HC-SO-2609-002", linkedAcDocNo: "SO-2609-002"}` must answer `MIGRATED`,
because a prefix strip would turn every migrated document in the corpus into an
ERP-raised one and empty the whole cutover verdict.

**Fix. NOTHING IS RECLASSIFIED, and that is deliberate.** The predicate is not
wired into the reconcile and the tally still counts all three exactly as before.
Two reasons: the headline number is what the owner has been reading for two days,
and quietly changing what it MEANS is worse than leaving it high; and moving
documents into a bucket is his call, not a side effect of adding a function.

What is shipped is the ability to answer the question per document:
`scripts/probe-so-differ-provenance.mjs` + its read-only workflow print both
sides of any named sales order and say which side the book's copy came from.

**The decision this puts on the table** — the ERP-raised population is not part
of the cutover the tally exists to verify, so it can either get its own named row
(count visible, never folded into `differ`) or stay where it is. Recommended: its
own row. The alternative guarantees the number never reaches zero for a reason
that has nothing to do with the migration.

**Ref.** fix/so-differ-zero, 2026-09-09.
