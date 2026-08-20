## The write-back opens a DUPLICATE master for a value the book already holds under another spelling [high]

**Symptom.** No error, and that is the point. The owner asked why so much has to
be opened at all — *"Branding、venue、sales、location、agent，你都可以做 binding
吧？…这样子之后就不用新开那么多，很多其实都已经有了"* — and he was right.
`/ensure-masters` opens a master AutoCount cannot find under exactly the string
it is given, so `SUNWAY SHOWROOM` does not fail against the book's own `SUNWAY`
(DUNLOPILLO SUITE SUNWAY): it opens a SECOND stock location, and one physical
showroom's stock lands in two rows of a licensed account book, permanently.
Nothing reports it, because from the sync's side every document succeeded.

**Root cause, traced against production** (read-only `autocount-field-alignment.yml`,
run 31815502403 on `main` for the warehouse count and run 31817727846 on the PR
branch for the per-dimension buckets, both 2026-08-14, company 1).

Two separate things, and only the first was known:

1. The four maps are **spelling corrections, not allow-lists** (2026-08-14, the
   entry below), so anything they had not been told about passes through and is
   opened. That was the right call — it is what makes a rep hired this month
   writable — but nobody had ever ASKED which of those pass-throughs the book
   already holds. **Eleven of the twelve `scm.warehouses` codes the
   field-alignment report calls unknown already exist**, as does the bulk of the
   venue and salesperson vocabulary.
2. The maps were hand-written object literals in `autocount-writeback.ts` while
   the record of WHY each binding is right lived in
   `scripts/data/autocount-so-writeback-mappings.json` beside them. **The two had
   drifted in all four dimensions** — the TS carried `ETHAN` and `WEI PIN`,
   confirmed out of the JSON's own `agent_map_fuzzy_to_confirm` and never written
   back, plus five identity location entries and `ZANOTTI`/`NONE`/`CARRESS`/
   `DUNLOP`. So the cheap way to confirm a binding was to edit TypeScript and
   leave the reason nowhere.

**Fix.** A matcher run as a REPORT, whose output a human confirms — never an
automatic binder, because a wrong bind writes the wrong place or the wrong
salesperson into a licensed book.

- `backend/scripts/lib/ac-master-matcher.mjs` — normalise, then score on
  IDF-weighted token overlap and edit distance. CONFIDENT means normalisation
  ALONE explains the difference (case, punctuation, word order, a `SOLO` suffix,
  `DISP`/`DISPLAY`, `SERV`/`SERVICE`, a dropped `WAREHOUSE`/`SHOWROOM`); LIKELY
  needs a shared word that names at most two masters in the whole book; a value
  sharing only common words is NO MATCH. Every proposal carries its reason.
- `backend/scripts/check-autocount-master-bindings.mjs`, run as a second step of
  the already-dispatchable `autocount-field-alignment.yml` — every distinct
  company-1 value per dimension, bucketed, with production row counts and a
  paste-ready fragment for the confirming edit.
- The four maps are now GENERATED from the JSON
  (`scripts/gen-autocount-master-maps.mjs` -> `src/services/autocount-master-maps.ts`,
  `npm run audit:ac-master-maps` in CI), so confirming a binding is an edit to
  the file that also carries the reason and never to TypeScript.

**What it does NOT do.** `BRANDING_MAP` stays an ALLOW-LIST — matching may
propose an addition, never a pass-through (the entry below has the measured
reason). `agent_excluded` stays a record of a decision, so a staff name that
reads as a test account and is not on it is NAMED (`Test Sales Director`, on a
live writable order) rather than added.

**Tests.** `backend/tests/acMasterMatcher.test.mjs` drives the matcher on the
real book vocabularies: all eleven codes confident with the right target,
`CHINA WAREHOUSE` no-match, `AEON BIG PUCHONG` never confident against the three
`AEON BIG` venues it is not, and every differently-spelled `agent_map` pair a
human already confirmed reproduced as a proposal.
`backend/tests/acMasterMaps.test.ts` pins every pair the maps carried at HEAD, so
generating them is provably behaviour-preserving and a binding can be added but
never silently removed or re-pointed. The matcher also asserts its own worked
examples before the report reads a row — a matcher whose rules rotted would
bucket everything as no-match, which reads exactly like a book that holds
nothing.

**Ref.** PR feat/autocount-master-bindings, 2026-08-14. Module guide §7p.
