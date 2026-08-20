## Three gates gave a different verdict on Windows than on Linux, and one of them hid a real defect [medium]

**Symptom.** `npm --prefix backend run audit:jsonb-binds`, `audit:swallowed-reads`
and `audit:test-schema` all failed on a Windows checkout of a tree whose Linux CI
was green. The test-schema one was the most misleading: it said "regenerate", and
regenerating produced a byte-identical file that `git diff` reported as unchanged.

**Root cause — the platform's own separators, in three places.** Each gate
compares something it builds at runtime against something committed, and each
comparison was written on Linux where the two forms coincide.

- `check-jsonb-binds.mjs:80` keyed its ALLOWLIST on `relative(REPO, file)`, which
  returns `backend\scripts\...` on Windows against a list written
  `backend/scripts/...`. No key ever matched, so the one deliberately allowed
  site was reported as a finding.
- `check-swallowed-reads.mjs:55` had the same bug against
  `swallowed-read-baseline.json`, whose 126 keys are posix because CI writes
  them. Every per-file ceiling lookup missed, so the ratchet reported the whole
  tree as 153 NEW sites.
- `gen-test-schema-snapshot.mjs:324` compared file text with `!==`. Git hands a
  Windows checkout CRLF; the generator always builds LF.

**Why the middle one mattered.** A ratchet that reports everything as new is not
merely noisy — it is unreadable, and an unreadable gate gets waved through. Under
those 153 phantom findings sat a REAL one: this branch had added 21 reads shaped
`const { data: own } = await <query>` with no `error` bound, in the very company-scope
guards it was adding. supabase-js does not throw, so on a database failure `own` is
undefined and the guard answers `404 not_found` — reporting an outage as "this
document does not exist". Fixing the path bug is what made that visible.

**Fix.** Normalise before comparing: `.split(sep).join('/')` on both scanners,
and an `eol()` that strips `
` before the snapshot comparison. Then bind
`error` at all 21 sites and return `500 lookup_failed` so a failed read can never
be read as an absent row.

**Ref.** PR #2140, 2026-08-14. Same family as the `#!` shebang trap and the CRLF
test anchors already in this file: **a gate that only runs green on CI's platform
is a gate the person doing the work cannot use.**
