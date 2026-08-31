## The screen told the operator to match the lines up and gave no way to do it [medium]

**Symptom.** A document held back for a keyless line renders, in the ERP's own
words: *"TO FIX: The lines have to be matched up against AutoCount, and then the
document saved again. Send again cannot do it — a change has nothing to
re-create."* Owner, 2026-08-31, looking at exactly that on HC-SO-013394 and
asking whether it could be fixed today. It could not: the instruction named an
action no screen offered.

**Root cause.** The repair landed as a route (`POST
/autocount-outbox/relink-lines`, `docs/bugs/0585-*`) with no control on either
surface, so it existed and could not be reached. A remedy an operator cannot
press is not a remedy.

**Fix.** A third button on the write-back screen — **Match up lines** — offered
only where `reason_kind === 'keyless-line'`, on the desktop page and on the phone
(`MobileAutoCountSync`), because a control on one surface and not the other is
the bug class this repo keeps paying for.

It is a THIRD DOOR rather than a flag on an existing one, and the distinction is
the point: Send again re-queues a document, Send now dispatches a waiting one,
and this **sends nothing**. It reads the document out of the account book and
repairs the ERP's own line identity. Saving the document is still what queues a
change — so the row's refusal deliberately STAYS after a successful match
(`clearsReason: false`), and the answer says so: *"Save the document again."*

The lines it could not match are NAMED in the note, not counted: each one is work
the operator still has to do, and "2 lines could not be matched" sends him
hunting.

**Tests** (`autoCountSync.test.tsx`): offered on the keyless row and on no other
(a missing warehouse is a different refusal with a different remedy); the answer
tells the operator the save is still theirs; and an unmatched line is named
rather than counted. They mount their OWN payload rather than adding a row to the
shared one — four tests above count that fixture's chips exactly, and a sixth row
would have failed them for a reason unrelated to what they assert.

**Ref.** feat/relink-button, 2026-08-31.
