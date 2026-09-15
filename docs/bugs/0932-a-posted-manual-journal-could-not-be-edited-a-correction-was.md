## A posted manual journal could not be edited: a correction was three moves by hand — Copy, post the draft, Reverse the old one [medium]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, on 2990-JE-2606-0163 (MANUAL, POSTED, the
card offering Reverse · Copy · Close): 「我无法 edit」. A posted entry is
immutable by design — the books never lose what was once posted — so a
wrong figure on a posted manual journal took three moves: Copy it, fix and
post the draft, then Reverse the old one; and a draft with a wrong line
could not be corrected at all short of posting it wrong or leaving it. Asked
whether a one-step Edit (reverse the old, post the corrected) should be
built: 要做.

**Root cause (traced).** `backend/src/scm/routes/accounting.ts` had a
create, a post and a reverse for a manual journal and nothing that changed
one; `JeDetailCard` (`frontend/src/pages/scm-v2/JournalEntryCards.tsx`)
offered Post / Reverse / Copy and the form only ever created.

**Fix.**

- **`backend/src/scm/routes/accounting-journal-edit.ts`** — `PUT
  /accounting/journal-entries/:id` (registered in
  `backend/src/scm/routes/accounting.ts`, the same GL key as create, post
  and reverse). The corrected entry is validated first through the engine's
  own gate (`validateJournal`: shape, balance, the chart, no control
  account), so a bad edit reverses nothing. A POSTED entry: the corrected
  entry is written as a draft; the old entry is reversed by a contra dated
  the OLD entry's own day (its month nets to zero — the payment re-post's
  rule) whose narration reads "Reversal of X — edited, replaced by Y"; the
  draft is posted. If the reversal fails the draft is deleted and the books
  are as they were; if the final post fails the response names the draft by
  number and its own Post button finishes the job. A DRAFT entry is rewritten
  in place — same number, no contra. A document's entry (`not_manual`) and a
  reversed entry (`already_reversed`) are refused by name; another company's
  entry reads as absent. Response `{journalEntry, lineCount, replaced:
  {originalJeNo, originalJeId, contraJeNo} | null}`.
- **`frontend/src/pages/scm-v2/JournalEntryCards.tsx`** — **Edit** on a
  manual journal not yet reversed (draft or posted) opens the same form on
  the entry's own date, number, narration and lines (`editSeedFromEntry`;
  unlike Copy, the party on each line is kept). The form's title reads
  "Edit 2990-JE-…" with what saving does; the button reads **Save & post** on
  a posted entry, Save draft on a draft; Save goes to the edit
  (`useEditJournalEntry`, `frontend/src/pages/scm-v2/accounting-phase1-queries.ts`),
  never to a create. `frontend/src/pages/scm-v2/Accounting.tsx` hands the
  entry from the card to the form.

No migration, no new number series (the corrected entry and the contra take
the next JE numbers of their months, as any post and any reversal do).

Pinned by `backend/tests/journalEntryEdit.test.ts` (the posted edit end to
end — the new number, the contra on the old day naming the successor, the
old lines untouched; a bad edit reverses nothing; the draft rewritten in
place; the four refusals) and `frontend/src/pages/scm-v2/JournalEntryCards.test.tsx`
(Edit hands over the entry with its parties, not on a system or a reversed
entry; the form titled by the number, dated the entry's day, Save & post to
the edit and never a create). Both RED before: the module and the seed did
not exist.

**Ref.** acc/je-edit, 2026-09-15.
