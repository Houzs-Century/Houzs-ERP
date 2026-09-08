## The AutoCount Sync page could never let go of a finished document [low]

**Symptom.** The owner, twice: three old test documents will not leave System ·
AutoCount Sync. Measured against production on 2026-09-08, that WAS the page —
Houzs Century's entire queue is 32 rows across three documents, `HC-SO-013361`
(9 sends, 7 of them `sent`), `HC-SO-013394` (10 / 8) and `HC-SO-013393` (13 /
13). All three are in the account book, and the page's own banner read
"Everything is in AutoCount. Nothing is waiting and nothing was refused." A
screen whose whole job is to show what still needs somebody had nothing on it
but finished work.

**Root cause (traced).** Not a defect in a line of code — a missing state.
`scm.autocount_outbox` is append-only by design (0277: *"Never delete rows: this
is the audit trail of what the ERP told AutoCount"*) and every row it has ever
held is either `pending`, `sent`, `failed` or `skipped`. Each of those four is a
claim about what AUTOCOUNT did. There was no way to record the different claim
"a person has finished with this", so nothing could ever leave the page.

**Two answers were ruled out before this one, and both matter.** Deleting is
forbidden by the table's own comment and by the owner's standing rule across the
ERP (never delete, only cancel). Writing a marker onto `last_error` is WORSE
than doing nothing: `isRequeuedNote`
(`backend/src/scm/lib/autocount-outbox-status.ts:318`) is a PREFIX test, chosen
deliberately so a row whose own message quotes the marker mid-string still reads
as an open refusal — so a second marker in front of a re-queued row's note stops
it classifying as `requeued` and pushes it back onto the Not accepted tab, which
is the opposite of what was asked. An earlier investigation reached exactly that
conclusion and stopped at "leave them alone".

**Fix.** A column of its own — `archived_at` / `archived_by`, migration
`20260908T0620_scm_autocount_outbox_archive.sql`. Nothing that classifies a row
reads it, so `acOutboxState`, `isRequeuedNote`, `classifyAcSkip` and
`acNeedsAttention` reach the same verdict on a cleared row as on a live one, and
clearing one column brings it back. `POST /api/scm/autocount-outbox/archive` and
`/restore` act per DOCUMENT (three finished documents would otherwise be 32
button presses), gated on the same keys as Send again, and REFUSE a document
that is still waiting or still needs somebody — the refusal comes back as a 200
with a sentence, which the page renders on the row that was pressed. The rule is
`acArchiveVerdict` in `backend/src/scm/lib/autocount-outbox-archive.ts`, proved
RED on the unfixed tree (the module did not exist); 11 unit tests plus 13 route
tests, including one that asserts the rows are still there and that `status` and
`last_error` were not touched.

**Ref.** fix/outbox-archive-payment, 2026-09-08.
