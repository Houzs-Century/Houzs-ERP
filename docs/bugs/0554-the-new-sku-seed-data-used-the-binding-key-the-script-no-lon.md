## The new-SKU seed data used the binding key the script no longer reads [low]

**Symptom.** The first dry-run of the 2026-08-28 new-SKU seed (run 33152112108,
`align-seed-skus.yml` with `data_file=scripts/data/ac-newskus-2026-08-28.json`)
reported `bindings: create 3, skip-existing 17` — while a read-only export of
company 1's live bindings (run 33152256221) showed **zero** of the 20 bindings
existing: FLAT carries only its NB rows, `5562-1S` and the DL-CLASSIC codes
carry none. A dry-run claiming 17 rows already exist that provably do not.

**Root cause (traced).** The data file wrote each binding row's material as
`material_code`, copying the shape of the 2026-08-05 file
(`align-seed-houzs-century.json`). `align-seed-skus.mjs` reads **`b.item_code`**
— the column was renamed in the batch-3 naming unification after that file was
written, and the script moved with the schema while the old data file (never
re-run) kept the old key. So `nkey(undefined)` = `""` gave every row of one
supplier the same dedupe key: the first row per supplier "created" (with an
undefined item_code — applying would have inserted three junk rows), the other
17 read as duplicates of it. 3 suppliers in the file = exactly `create 3, skip
17`.

**Fix.** The data rows now use `item_code`. Caught before any apply by the
repo's own rule — a contradiction is a finding: the dry-run's skip count was
checked against a fresh read-only export instead of being believed. Follow-up
recorded in the round ledger: after this seed applies, run
`mirror-hookka-bindings` so Hookka Manufacturing gets its mirrored rows and the
main flag is asserted once for every OHANA-bound material (it also demotes
FLAT's NB main in favour of Hookka Industries, per the owner's standing 08-09
ruling).

**Ref.** fix/ac-newskus-item-code, 2026-08-28.
