## The description tidier called 249 of the owner's own fabric codes broken [medium]

**Symptom** — the 2026-08-14 production plan of `tidy-fabric-descriptions.mjs`
reported 78 Fabric Converter rows and 171 selling-library rows as
`code is not canonical (would be DE-01) — fix the CODE first`. Every one of them
is a code the owner dictated himself: `DE01`, `NX010`, `ZL-03`. Nothing was
written — those rows fail the canonicality guard and stop there, and the run
ended `WOULD REWRITE: 0` — so no data was harmed. The damage is to the report:
249 correct rows filed beside the real problems.

**Root cause** — the twelve series `seed-owner-fabric-catalogue.mjs` drove to
the owner's own list (2026-08-11) are a DECISION, not a derivation.
`normalize-fabric-codes.mjs` knew that and skipped them — using its own private
copy of the list, `const CATALOGUE_SERIES = new Set([...])` at line 81.
`tidy-fabric-descriptions.mjs` had no copy at all, so it applied the generic
series+number rule to codes the generic rule does not own.

Two scripts, one rule, one of them holding the only copy: the same shape as the
five fabric matchers that drifted apart before #1893 pulled them together.

**Fix** — `backend/scripts/lib/catalogue-series.mjs` holds the list once and
answers `isCatalogueSeries(parsedSeries)`. Both derivers import it. The tidier
now reports those rows in their own line — *the owner's own 12 catalogue
series, left exactly as he dictated* — instead of mixing them into the
unparseable bucket.

**The check** — `backend/tests/catalogueSeriesOneList.test.mjs`, wired into
`npm run test:scale-contract`. It fails on the tree as it was (2 of 5 tests),
and it asserts three things a comment cannot: both derivers import the shared
list; a series the SEED declares is one the shared list holds, so the seed
cannot add a series the derivers would then trample; and no other script holds
the whole list. That last one is measured rather than assumed — only the seed
and the shared module name all twelve, and the next highest file names 7, so
"names all twelve" separates a copy from a mention with room on both sides.

**Class** — *the same rule in two places*, docs/bug-classes.md. The instance
that hurts is not the one that disagrees loudly; it is the one where the second
place does not know the rule exists.

**Ref** - `fix/catalogue-series-one-list`, 2026-08-14
