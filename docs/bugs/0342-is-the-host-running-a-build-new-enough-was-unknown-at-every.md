## "Is the host running a build new enough" was UNKNOWN at every point it mattered [medium]

**Symptom.** Not a wrong answer — a missing one, repeatedly, and always at the
moment a decision depended on it. Does the office host have the creditor-name
comparison? `FromDocNos`? The per-line quantity? Every answer was "check
`/health`", and `/health` is a terminal that scrolls away.

**Root cause.** `/health` has answered `builtAt` (the exe's own file timestamp)
and `mvid` (unique per COMPILATION) for a while. **Nothing stored either.** So
the state of the host lived only in whoever last ran the probe, and the failure
mode is the one this repo keeps paying for: a feature the host does not have is
byte-for-byte indistinguishable from a feature that ran and found nothing.
`docs/generated/autocount-coverage.md` says so in as many words about the
creditor mismatch report — `mismatches` is empty when the host is too old to
compare, and empty is exactly what agreement looks like.

**Fix.** Migration 0304 adds `host_built_at` / `host_mvid` to
`scm.autocount_outbox`. The drain reads `/health` once per sweep — and only when
there is a row to send, so an empty five-minute tick does not knock on the office
host — and stamps it on every row it dispatches.

**On the ROW, not one current-state key**, because it answers two questions and
the second is the one asked during an incident: the newest non-null row says what
the host runs now; a row's own columns say what answered THAT row a year ago.
`docs/autocount-sync-reasons.md` §5 proposed exactly this shape.

Not stamped on `waiting`: nothing was sent for that row, and recording a build
against it would assert a conversation that did not happen. NULL is a real answer
— dispatched before the columns existed, or `/health` unreadable that sweep —
and it is **not backfillable**, which the migration says out loud. A `/health`
that fails costs nothing: a diagnostic must never stop a document reaching the
account book.

**Tests.** Three: the stamp lands on a sent row; a `waiting` row is not stamped;
a null build still sends. The first proven red against `const stamp = {}`.

**Ref.** 2026-08-18, `fix/ac-sync-close-gaps`.
