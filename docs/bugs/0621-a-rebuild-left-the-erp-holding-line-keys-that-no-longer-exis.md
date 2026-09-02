## A rebuild left the ERP holding line keys that no longer exist [high]

<!-- area: AutoCount sync + write-back -->

**Symptom, caught before it broke anything, by the owner asking twice.** After
HC-SO-013394 was rebuilt and verified correct in the account book, the ERP still
reported **"8 lines total — 7 carry linked_ac_dtlkey, 1 does NOT"**: the exact
split it had before either rebuild. The book's keys had by then moved twice and
stood at `919855`-`919862`. So the two sides disagreed about every key on the
document, and the NEXT ordinary edit of it would have composed
`EditDetail(<dead key>)` and been refused by the host with "line ... not found".

Nothing had failed yet. The owner's question was 「确定干净了？不是矛盾的？」, and
it was not clean.

**Root cause (traced).** A rebuild clears the details and re-adds them, so every
key the host returns is NEW — but nothing told the ERP that.
`newLineTargetOf` decides what to store back by reading `IsNewLine` off the
payload, which only the *declared-new* branch ever sets, and it collects the
payload's existing `DtlKey`s into `knownKeys`, which `persistNewLineKeys` then
uses to filter returned keys out as "already had it". On a rebuild both readings
are wrong in the same direction: no line is marked new, and every key it treats
as known is dead. The function returned `null` and stored nothing.

**A second fault underneath it, found by dumping the payload rather than
reasoning about it.** The line mapper stamps each rebuilt line with the ERP rows
behind it, but a KEYLESS line never reaches that code — `if (dtlKey == null)
return d;` returns the raw detail, correctly, because a new line keeps its item
code. So a rebuilt document named its ERP rows on every line except that one,
and `newLineTargetOf` refuses the whole batch when a line names none. The
symptom would have been silent: keys stored for no document at all.

That one was invisible to reading. The first test asserted "every rebuilt line
names the ERP rows behind it" and failed on **line 2 of 2** — the payload dump
showed its keys in a different ORDER from line 1's, which is what identified the
second construction path.

**Fix.**

* `erpLineIdsOf` in `backend/src/services/ac-line-gone.ts`, used by BOTH branches
  of the mapper, so a rebuilt line names its ERP rows whether or not it had a key.
* `newLineTargetOf` reads `Rebuild` off the payload: every line counts as new and
  `knownKeys` is empty, because after a clear no key the payload carries still
  exists. An ordinary edit is untouched and still stores only what the route
  DECLARED — reading every line back there would repoint keys the book owns.

**Also fixed here: the report contradicted itself in the same breath.**
`check-autocount-held-back.mjs` printed `[already re-queued — history, not an
open item]` against a row and then counted that same row in `DISTINCT DOCUMENTS
HELD BACK`. It said one document was stuck while the document was demonstrably
fine. A re-queued row is now excluded from the count and reported separately as
history.

**Verified.** `backend/src/scm/lib/autocount-requeue-edit-rebuild.test.ts` gains
three tests — every rebuilt line names its ERP rows, `newLineTargetOf` reads a
rebuild as all-new with no known keys, and an ordinary edit still names nothing
new. The first two were proven RED (`line 2 names no ERP row`, `a rebuild names
no lines to store: expected null not to be null`). 691 tests pass across the
AutoCount area. Backend typecheck exit 0.

**Still outstanding for the document already rebuilt.** HC-SO-013394's stored
keys are dead TODAY — this fix applies to the next rebuild, not retroactively.
Re-running the rebuild once this is deployed is what repairs it, and the run is
recorded in the PR.

**Ref.** fix/ac-rebuild-persists-line-keys, 2026-09-03.
