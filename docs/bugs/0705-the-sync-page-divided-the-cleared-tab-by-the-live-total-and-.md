## The sync page divided the Cleared tab by the live total, and said "3 of 1 document" [medium]

**Symptom.** The owner opened the AutoCount Sync page the hour the Cleared tab
shipped, clicked it, and saw three rows sitting under the words

```
Cleared | 3 of 1 document
Showing 1–3 of 1 document
```

He asked what had gone wrong. Three of one is not a fraction, and on a page whose
entire job is telling somebody whether a document reached the account book, a
count that cannot count is the last thing that should be on screen.

**Root cause (traced).** `counts.archived` is deliberately NOT summed into
`counts.total`. The type says why, in its own words: every other number in that
object is a claim about what AutoCount did, and this one is a claim about what a
PERSON decided. That is the right design and it is not what broke.

What broke is that both count lines read `total` **on every tab**:

```
frontend/src/pages/AutoCountSync.tsx:955    acListCountLine(groups.length, d.counts.total)
frontend/src/pages/AutoCountSync.tsx:1008   acShowingLine(live.length, d.counts.total)
```

So on the Cleared tab the numerator counts archived documents and the
denominator counts live ones — two different populations either side of the word
"of". With one live document and three cleared, that renders "3 of 1".

**Why nothing caught it.** The counts object was an anonymous inline shape inside
`AcOutboxResponse`, so there was no type to hang a helper off and no name to
search for. Each call site reached in for `total` by hand because that was what
was to hand, and no test could be written that made the two agree — there was
nothing to write it against. This is the repo's own **"a default is a decision
nobody reviews"** trap in its quietest form: not a defaulted parameter, but a
defaulted *field*, picked because it was the obvious one.

**Fix.**

1. `AcOutboxCounts` is now a named exported interface
   (`frontend/src/lib/autocountOutbox.ts`), so the shape can be passed whole.
2. `acRegisterTotal(counts, state)` in `frontend/src/lib/autocountRegister.ts`
   picks the population the tab is actually showing. **`state` is required and
   there is no default** — the compiler now asks every call site which population
   it means, which is the same rule that would have prevented this.
3. Both call sites on the desktop page pass the tab.

Tests: four in `frontend/src/lib/autocountRegister.test.ts` under *the
denominator the count lines divide by* — the cleared tab counts against cleared,
every other tab counts against live, the owner's exact sentence, and an empty
Cleared tab reading "none of 0" rather than "none of 1".

**Not the same bug as `docs/bugs/0298-autocount-sync-listed-one-row-per-send-and-called-the-count.md`,
and worth saying so.** That one was the numerator: the page listed one row per
SEND and called it a document count. This one is the denominator. Both produce a
wrong fraction on the same line, which is exactly why the next person needs to be
told they are different, or they will read 0298 and believe this was already
fixed.

**What is NOT wrong, because the owner asked.** Nothing was deleted. The three
documents on his Cleared tab are still in the queue and still on the page — they
appear there *because he clicked Cleared*, and `Put back` returns any of them to
the list. The queue is the audit trail of what the ERP told AutoCount and its
migration says never to delete a row of it.

**Both surfaces.** The phone screen (`frontend/src/mobile/MobileAutoCountSync.tsx`)
carried the identical defect at its own two call sites and is fixed in the same
PR. Fixing one surface and not the other is a named recurring bug class here.

**Ref.** PR pending, 2026-09-08. Pages: `frontend/src/pages/AutoCountSync.tsx`,
`frontend/src/mobile/MobileAutoCountSync.tsx`.
Guide: `docs/modules/autocount-writeback.md`.
