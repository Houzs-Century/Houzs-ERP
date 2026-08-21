## CLAUDE.md told every session four things that were not true, and it is auto-loaded [high]

**Symptom.** None you could see. `CLAUDE.md` is loaded into every session before
anyone reads a line of code, so a wrong sentence in it is not a stale document —
it is a wrong belief installed in everyone who works here. It has form: it
described the database as D1 SQLite for a month after the Postgres cutover, and
carried a required-status-check list that was simply wrong.

**Four found on 2026-08-15, all in the file that everybody trusts most.**

*1. "CI ... does NOT run `audit:route-locator` or `audit:map`."* `audit:map` had
been a `ci.yml` step since the previous day —
`grep -c audit:map .github/workflows/ci.yml` answers 1. The claim sends the
reader away from regenerating the map, and then their PR fails on it. Only the
`route-locator` half was true.

*2. The same bullet said it TWICE, in two paragraphs that contradicted each
other*, and the second began mid-sentence — `largest files), regenerated from the
tree.` — a paste that never deleted what it replaced.

*3. A worked drift example that no longer held:* "`codebase-map-facts.md` IS
drifted at HEAD — it records `consignment-returns.ts` at 957 lines against an
actual 1118". The map and the file now both say 1141. **A stale worked example is
worse than no example**: it reads as freshly measured evidence.

*4. "Treat `skipped` on `backend` as a failed deploy", full stop.* Over-broad in
the expensive direction. `deploy.yml`'s filter is `backend/**` plus the workflow
itself, so a docs-only PR legitimately skips that job with the RUN concluding
`success`. Measured the same day: #2207 touched only `BUG-HISTORY.md`,
`docs/generated/` and `scripts/check-file-size.mjs`, and the old wording would
have had someone call it a failed production deploy. The signal is the PAIR —
`failure` + `skipped` is the incident; `success` + `skipped` is the filter
working.

And one of these was self-inflicted the same night: the shebang rule named
`tests/scale*.node.mjs`, files renamed to `*.test.mjs` by #2180 — the rename did
not update the rule that points at them.

**Root cause.** `check-docs-drift` resolves a claim whose PATH is gone. It cannot
resolve a claim about BEHAVIOUR — "CI does not run this" — and that is exactly
the shape that misleads, because it reads as settled fact and points the reader
the wrong way. Nothing checked it, so nothing caught it.

**Fix.** The four sentences are corrected, each with a dated `CORRECTED` note
saying what it used to say and why that was wrong — deleting the error silently
would leave the next reader unable to tell which version they remember.
`backend/tests/claudeMdClaims.test.ts` then pins them: the gated/not-gated table
is compared against `ci.yml`, the deploy rule must keep the run-conclusion pair,
and the shebang rule's named test files must exist.

**Proven red in BOTH directions**, which is the point for a claim like this:
editing the table to say "NO" fails it, and removing `audit:map` from `ci.yml`
fails it too, with the message naming which side moved.

**Ref.** 2026-08-15. Lesson: **the more trusted a document is, the more expensive
its errors are, and CLAUDE.md is the most trusted one here** — it is read by
everyone, before anything else, and never questioned. Its checkable claims should
be checked.
