## An unknown area tag in a bug entry turned a required check red and blocked every merge [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** From 2026-08-17, every open pull request failed `backend-typecheck`
— a REQUIRED context — with a message about a document none of them had
touched: `BUG-INDEX: "The card-style task block showed a dead Approve button on
al" carries <!-- area: PMS checklist status / approvals -->, which is not an
area.` `main` itself was red, so nothing could land behind it.

**Root cause (traced, not guessed).** #2363 hand-wrote its own area tag instead
of taking one of the seventeen `gen-bug-index.mjs` accepts. That script refuses
an unknown area rather than falling back to its keyword guess, and the refusal
is deliberate — "a typo that silently reverts to guessing is the failure this
tag exists to remove" is its own error text. What it did not anticipate is
WHERE it runs: `audit:bug-index` sits inside `backend-typecheck`, so a one-line
typo in a Markdown comment is a repo-wide merge stop. Confirmed by running
`npm --prefix backend run audit:bug-index` against a clean `origin/main`
checkout: exit 1, with `main` carrying the tag at `BUG-HISTORY.md:404`.

**Fix.** Retagged that entry to `Projects + PMS + fair report`, the area three
other PMS entries already carry. The entry's text is unchanged.

**Not fixed here, and worth someone's judgement:** the author of #2363 could
not have been told. The tag is validated only by a job that runs after the
merge, so the check that fails is the one nobody could act on before landing —
the actor who can fix it and the actor it fails are different people. Either
the validation belongs on the PR that writes the tag, or the area list belongs
somewhere the writer reads.

**Ref.** PR #2364, 2026-08-17.
