## A comment stripper that lost its place at `=> "?"` [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

`check-company-divergence.mjs` reported `backend/src/scm/lib/companyScope.ts:294`
as an unreviewed per-company branch. Line 294 is not a branch — it is a JSDoc
line that QUOTES the rule it is explaining: *"THE BASE COMPANY, resolved from
`companies.code === 'HOUZS'` on context"*. The gate strips comments precisely so
an explanation is never reported as the offence. It had stopped stripping.

**Ten lines earlier.** `const inList = values.map(() => "?").join(", ");`. The
stripper decides whether a quote OPENS a string by looking at the previous
non-space character against a set of "opener" characters. `>` was not in that
set. So the opening `"` of `"?"` read as ordinary code and was passed through —
and then the CLOSING `"` was judged by ITS previous character, `?`, which IS an
opener. The stripper entered string-state at the end of a string literal and
never left. Every comment from there to the end of the file survived and was
scanned as source.

The failure is quiet in the direction that matters: string-state emits its
characters verbatim, so nothing was HIDDEN — the count came out too big, not too
small. It cost a reader an afternoon deciding whether a doc comment was a
divergence.

**Both copies had it.** This stripper was lifted from
`check-empty-state-claims.mjs`, which has been in CI since 2026-08-18 with the
same missing character. Latent there only because no comment in the tree happens
to match one of its claim shapes after a desync — not because it is correct.

**Fix.** `>` joins the opener set in both scripts, which also makes the two other
`>` positions right: a comparison (`a > "b"`) and JSX text after a tag close
(`<p>"quoted"</p>`) are both string openers too. Each script's startup self-test
gains the arrow-function probe; both were run with the fix reverted and both exit
2 with the probe named, so neither can regress silently. The hit list before and
after the fix differs by exactly one line — companyScope.ts:294 — with nothing
added and no reviewed entry lost.
