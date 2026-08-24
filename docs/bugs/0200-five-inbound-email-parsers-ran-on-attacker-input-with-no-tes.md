## Five inbound-email parsers ran on attacker input with no test, inside a file over its size ceiling [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Context.** The owner's decision, 2026-08-15: pay the file-size debt down BEFORE
making `file-size` a required check, so the lock never blocks an urgent fix.
`main-protection` has `bypass_actors: null` and `current_user_can_bypass: never`
— verified, not assumed — so a required check that blocks a production fix cannot
be overridden by anyone, including the owner. Shrink first, lock second.

This is the first payment: `routes/mail-center.ts`, the smallest offender, 6
lines over.

**What was there.** `toArray`, `stripHtml`, `safeIso`, `base64ToBytes` and
`safeFilename` — five pure functions, inline in a 2,329-line route file, **with
no test of any kind**. Every one of them runs on the inbound-email webhook, so
every input is attacker-controlled:

- `safeFilename` is the path-traversal guard on the R2 object key. Nothing
  asserted that `../../etc/passwd` became `passwd`.
- `base64ToBytes` returns `null` rather than throwing so one bad attachment
  cannot abort a whole email. Nothing asserted it.
- `safeIso` keeps a malformed `Date:` header out of a timestamp column. Nothing
  asserted it.

**Change.** Moved VERBATIM to `services/mail-parse.ts` — pure, so no env, no
database, no R2 comes with them — and `backend/tests/mailParse.test.ts` now pins
the behaviour. The tests passed on their FIRST run against the moved code, which
is what makes "moved verbatim" a checked claim rather than an assurance.

`mail-center.ts` 2,329 -> 2,284, under its 2,323 ceiling; the ceiling then
lowered to 2,284 so the gain cannot be re-consumed. **Only that one ceiling** —
`--update` would have taken back 276 lines of slack across 9 other files, and
with four PRs in flight that could break one of them mid-air.

**A red proof that could not be taken, stated rather than faked.** Adding lines
back to prove the new ceiling bites does NOT fail this PR, and the gate is right:
it charges a file only when THIS change GREW it (`x.lines > was`, where `was` is
the line count at the merge base). At 2,286 the file is still smaller than the
2,329 it was, so nothing is charged. The lowered ceiling binds the NEXT change,
whose base will be 2,284. Verified by reading `charged()` in
`scripts/check-file-size.mjs`, not by an experiment that would have proved
something else.

**Ref.** 2026-08-15. Debt 1,391 -> 1,385 lines, 13 -> 12 files.
