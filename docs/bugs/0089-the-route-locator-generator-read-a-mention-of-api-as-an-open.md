## The route-locator generator read a mention of `/api/*` as an opening block comment [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- ^ TAGGED because no keyword table can place this one. It is about a
     GENERATOR, and it necessarily says "route" a dozen times, so the Fleet
     pattern (fleet|lorry|driver|trip|route|...) outscores the tooling one on the
     body even though both match the title once. Widening a pattern to fix it
     would drag in every entry that mentions a route. -->

**Symptom** - `docs/generated/route-locator.md` reported "986 route registrations
across 128 files". The tree holds 1,021 across 136. Eight whole route files were
absent, including `so-mirror.ts` (a pre-auth 2990 mirror) and `public-images.ts`
(a pre-auth R2 proxy) — exactly the kind of endpoint someone greps this artifact
to find.

**Root cause (traced, not guessed)** - `stripComments` in
`gen-route-locator.mjs` cut the `//` line comment LAST, after testing for a
`/*` block opener. So a line like `// Mounted at '/api/sync/so-mirror' ...
above the /api/* wall` had its `/api/*` read as an opening block comment;
`inBlock` then stayed true to end of file and every route below it vanished. The
five SCM routers found this way (`addons`, `maintenance-config`, `pos-cart`,
`public-images`, `so-mirror`) all carry a header comment mentioning a wildcard
path. Proved by re-running the generator's own `stripComments` over each file
and printing the first line it swallowed.

**Fix** - cut the line comment before looking for `/*`. Regenerated: 986 -> 1021
registrations, 128 -> 136 files.

**What this is really about** - the artifact was regenerated earlier the same day
and reported as repaired in `docs/staging-bench-rot-coe.md`. Regenerating proved
the generator RAN; nobody checked that its output matched the tree. A generated
file can be current and wrong at once, and "I regenerated it" is not the same
claim as "it is correct". The sibling check that would have caught it —
comparing the artifact's file list against the routers on disk — did not exist
and still does not.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---
