## An edit was refused for an item code it was never going to send [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-PO-006690` cannot reach AutoCount:

> refused, nothing sent (ItemCodeError): 1 line(s) have no single AutoCount
> ItemCode: line 1 — ERP item code `DIVAN ONLY-(Q)` maps to 4 AutoCount items
> and none belongs to supplier `400-H003`

**Root cause.** `composeEdit` strips `ItemCode` from every line the book already
holds — the owner's rule of 2026-08-13, written into that function in as many
words: *AUTOCOUNT OWNS THE ITEM ON A LINE IT ALREADY HOLDS*. But it asks
`composeDetails` to compose the details FIRST, and that function resolves every
line's item code and throws `ItemCodeError` on any it cannot pin down.

So the edit was refused over a code the payload was never going to carry.

**The precedent was already in the same function, five lines away.**
`forTransfer` exists for exactly this: *"A TRANSFER KEEPS THE LINE. The ItemCode
below is never sent — so the ERP code stands in for it."* The edit path is the
same statement and had never been written down.

**Fix.** A line whose ItemCode will not be SENT is not refused for it.
`keyedLinesKeepTheBooksItem` is set by `composeEdit` and by nothing else, since
it is the only caller that strips the code.

**The two halves that must NOT move, and are asserted:**

* **A KEYLESS line still refuses.** On an edit it is APPENDED, and it carries
  its ItemCode into a licensed ledger. An unresolvable one there is real.
* **A REBUILD still refuses.** A rebuild puts every ItemCode back.

**A measurement that corrected the first draft of the test.** `DIVAN ONLY-(Q)`
resolves happily when NO creditor is named — the resolver picks
`HOK-DIVAN ONLY (Q)`. It refuses only when a creditor is named and holds none of
the four, which is `HC-PO-006690`'s: measured 2026-09-09, `400-H003` refuses and
`400-O002` does not. The first draft of the create-still-refuses test named no
creditor, so it passed for the wrong reason — nothing to refuse. Every case now
names one.

**Verified.**

* `editKeepsTheBooksItem.test.ts` — **3 tests**: a keyed line composes and
  carries the book's key with NO ItemCode; a keyless line still throws; a create
  still throws.
* `src/services` + `src/scm/lib` — **2,601 passed**, 176 files.
* `npm --prefix backend run typecheck` clean.

**UNTESTED against production** — `HC-PO-006690` has not been re-sent under this
build.

**It does not fix the CELENE purchase order**, which is the same shape: the owner
ruled 「不需要 就remain」 on that one, and its rows are `skipped` and alarm on
nothing.

**Ref.** fix/an-edit-does-not-need-a-code-it-will-not-send, 2026-09-09.
