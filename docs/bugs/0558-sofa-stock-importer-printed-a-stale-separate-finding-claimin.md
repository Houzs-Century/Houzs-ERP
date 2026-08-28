## Sofa-stock importer printed a stale SEPARATE FINDING claiming 128 pillow units were excluded and absent from ERP [low]

**Symptom.** Every run of `backend/scripts/import-ac-sofa-stock.mjs` ended with
"SEPARATE FINDING — 128 pillow units … excluded by the /SOFA/ code filter …
absent from ERP stock". During the 2026-08-28 re-import that message was read as
an open data gap and nearly spawned a repair task for stock that was already
correct.

**Root cause (traced).** The message was prose frozen at the time the script was
written (early August), when the balance importer selected rows by a `/SOFA/`
regex over item codes. The balance importer has been CATEGORY-based since then —
it takes every row whose mapping-CSV category is SOFA — so sofa-coded pillow
rows now flow through the normal balance import. Proved by re-running
`import-ac-balances.mjs` in plan mode against the 2026-08-28 snapshot after the
full import: **0 missing cells** — nothing the message described was actually
absent. The message itself did no measuring; it printed a constant.

**Fix.** The block now measures instead of asserting: it loads the mapping CSV's
SOFA-category code set and reports only pillow-named sofa-coded rows that are
genuinely outside that set (i.e. rows neither importer would pick up), printing
the honest count — which is zero on the current snapshot. Same PR also removes
the claim from the run log people copy into ledgers.

**Ref.** fix/reimport-round-hygiene, 2026-08-28.
