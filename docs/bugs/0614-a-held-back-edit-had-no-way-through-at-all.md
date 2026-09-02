## A held-back edit had no way through at all [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** HC-SO-013394 sat held back from 2026-08-31 to 2026-09-02 — the only
document in the whole queue that was stuck. Everything the screen told the
operator to do was impossible, and the row carried no button at all.

**Root cause (traced, and the second half was measured against the live account
book).**

Two independent things had to be true for a document to be stranded, and both
were:

1. **An `edit` was never re-queueable.** `requeueOneRow` refused every `edit`
   row, and `acRowIsRequeueable` returned `false` for `edit`, so the AutoCount
   Sync page showed no control on it. The stated remedy was "fix the cause and
   save the document again" — which does re-queue an edit, and which could not
   work here, see below.
2. **Its one keyless line can never be matched.** Read off the live book on
   2026-09-02 (`SODTL` joined to `SO` on the office host, `AED_HOUZS`):
   `SO-013394` holds **ten** lines against the ERP's eight, and the item code
   `JM-CL JAC WP MP` appears on **three** of them — `(K)`, `(Q)` and
   `(Q) [ERP-CANCELLED]`. No matcher can choose between those, so
   `POST /autocount-outbox/relink-lines` was never going to fill the missing
   key, and the owner is right about the button the screen named:
   「不需要 match up line 啊，这个 button 都没必要用了」.

**The refusal's own reasoning is what pointed at the fix.** An `edit` was refused
because a skipped row's payload is `{}`, so the `retire` entries the original
save carried — the lines it hard-DELETED — are unrecoverable, and a re-composed
KEYED edit would leave those lines live and transferable in the account book.
Every word of that is true. **A REBUILD needs none of that list**: it clears the
document's details and lays the ERP's current lines down, so the two sides finish
identical — which is what the retire entries were approximating, and what the
owner actually asked for: 「我是要 autocount 的全部 line 都跟 ERP 一样」.

**Fix.** An `edit` may be re-sent, and only ever as a rebuild.

* `editRebuildVerdict` in `backend/src/scm/lib/autocount-requeue.ts` is the new
  rung. It composes through the real `enqueueEdit` with `rebuild: true`, so the
  verdict comes from the composer rather than from a string this module invents.
* `enqueueEdit` gained `rebuild?: boolean`, threaded into `composeSoState` and
  `composePoState`. `composeDownstreamState` deliberately does NOT take it — the
  absence of the parameter is the rule from
  `docs/bugs/0611-a-converted-document-could-be-rebuilt-which-destroys-its-tra.md`.
* `acRowIsRequeueable` now offers the button on an `edit`.

**It is still never automatic, and that is the whole safety.** A rebuild destroys
and reissues every AutoCount line key on the document, so
`docs/bugs/0613-rebuilding-any-unmatchable-document-went-further-than-the-ru.md`
stands: an ordinary save of a document with a keyless line still refuses rather
than silently paying that price to avoid backfilling one key. This runs only when
an operator re-sends a document that is ALREADY held back. Two refusals survive
untouched and neither is re-implemented here — `rebuildAllowed` refuses a
converted document and one whose keys a purchase order holds, and the HOST
refuses a document its own tables say was transferred.

**The blast radius, stated rather than implied.** The batch sweep selects by
STATUS and not by op, so a broad `requeue-autocount-skipped` run with APPLY will
now rebuild held-back edits too. Measured on production 2026-09-02, run
33635685315: the entire queue held **19 rows, and exactly one document** was
held back. A sweep can be narrowed with `docNo`, and the per-row button is the
one-document path.

**One thing the button now does that the hint cannot see.** `acRowIsRequeueable`
takes an op and no document type, so it offers the button on a delivery order's
edit as well, and the ladder then refuses it in words. That is the same trade
this file already made for conversions on 2026-08-24 — a refusal that explains
itself beats a control that is simply absent.

**Verified.** `backend/src/scm/lib/autocount-requeue-edit-rebuild.test.ts` (4
tests) asserts on the PAYLOAD the host receives, not on the verdict text; proven
RED first by restoring the old op gate (3 of 4 failed). Three existing tests that
pinned the old rule were updated rather than deleted, and one button assertion
flipped with its reasoning written beside it. 684 tests pass across the AutoCount
area. Backend typecheck exit 0.

**Ref.** fix/autocount-rebuild-on-requeue, 2026-09-02.
