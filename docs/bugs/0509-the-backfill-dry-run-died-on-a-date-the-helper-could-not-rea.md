## The backfill dry run died on a Date the helper could not read [low]

**Symptom.** The first production dry run of
`backfill-so-processing-date-from-po.mjs` (run 32504621173, 2026-08-21) read its
28 target orders and then exited 1 with `Invalid time value`. Nothing was
written — the failure happened before the transaction — but the owner got no
plan to approve.

**Root cause (traced).** `postgres.js` returns a JS `Date` for a `date` column,
and the helper coerced with `String(d).slice(0, 10)`. On a `Date`, `String()`
yields `"Thu Jun 11 2026 00:00:00 GMT+0000 (…)"`, so ten characters is
`"Thu Jun 11"` — which matches no date pattern, so `ymd()` returned `null`, and
`minusOneDay` then built `new Date("nullT00:00:00Z")`.

**The evidence was already on screen and was read past.** `probe-so-date-xor`
printed its dates as `Thu Jun 11 2026 00:00:00 GMT+0000` in the very output that
sized this population. The shape of the value was visible hours before the
helper that could not parse it was written.

**Fix.** `ymd()` handles a `Date` directly and takes the calendar day from
`toISOString()` — UTC, because a `date` column carries no timezone and a
local-time read can slide it by a day. A string still has to match
`YYYY-MM-DD` to be accepted rather than being truncated blindly.

**Second defect, same run, different script.** `check-doc-no-prefix.mjs` named
`delivery_returns.dr_number` and `purchase_returns.pr_number`; both tables call
the column `return_number`. The script reports an unreadable column instead of
crashing, which is right — but it then printed a VERDICT computed over six of
eight document types, reading as if it covered all eight. That is the
"a verdict computed over nothing must never read as a pass" shape CLAUDE.md
names, in its milder form: a verdict computed over less than it claims.
Both names corrected.

**What the two failures have in common, and it is the useful part.** Neither was
caught by types, lint or tests, because neither script is in the typecheck or
test scope — `backend/scripts` is excluded from both. The only thing that could
catch them is RUNNING them, and the only reason running them was safe is that
both default to a mode that writes nothing. The dry-run default is not
ceremony; it is the test suite for this class of file.

**Ref.** `fix/backfill-date-coercion`, 2026-08-21. Found by dispatching the
workflows against production after they reached `main`, per the rule that a
`workflow_dispatch` workflow is not shipped until it has been dispatched once.
