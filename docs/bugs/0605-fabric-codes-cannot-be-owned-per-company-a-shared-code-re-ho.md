## Fabric codes cannot be owned per-company — a shared code re-homes or is refused [high]

**Symptom.** The two companies (Houzs Century = company 1, 2990 = company 2) could
not each own the SAME fabric code. Owner, 2026-09-02: 先把两个公司的数据分离. When
one company bulk-imported a fabric code the other already had, the import was
REFUSED with a 409 (`fabric_id_belongs_to_another_company`) — and before that guard
was added, the import silently OVERWROTE and RE-HOMED the other company's row (the
original owner could no longer see or delete it).

**Root cause (traced).** `scm.fabric_trackings.id` is a text PRIMARY KEY and the
id IS the fabric code — `POST /` and `/bulk-upsert` derive it as
`code.toUpperCase().replace(/\s+/g,'_')` (`fabric-tracking.ts`). `company_id` was
added as a COLUMN only (mig 0083, backfilled to HOUZS), never as part of the key.
So a code belonged to exactly one company globally. The bulk upsert used
`onConflict: 'id'` → `ON CONFLICT (id) DO UPDATE` while stamping `company_id`, which
re-homed the other company's row; the 409 pre-check (`.select('id, company_id')
.in('id', batch).neq('company_id', cid)`) was a workaround that turned the re-home
into an outright refusal. Confirmed no FK depends on `fabric_trackings.id`: grep of
the whole backend for `REFERENCES ... fabric_trackings` returns zero, and the
vendored `2990s-full-schema.sql` shows the only inbound fabric link is
`products.fabric_color = fabric_code` (a plain text column, no constraint).

**Fix.** Migration `0342_fabric_trackings_per_company_pk.sql` drops the
single-column PK (name-agnostically) and adds composite PRIMARY KEY
`(company_id, id)`; the bulk upsert repoints to `onConflict: 'company_id,id'` and
the 409 guard is removed (`fabric-tracking.ts`). The same code under two companies
is now two legitimately different rows. Existing rows are untouched — `company_id`
was already HOUZS on every row, so `(company_id, id)` is unique across them and the
composite PK builds without moving or deleting data. Pinned by
`tests/fabricCodePerCompany.test.ts` (behavioral: company 1 then company 2 import
`CG-001`, both land, no 409, neither re-homes; plus a source-scan that the removed
409 stays removed). Proved RED on the pre-0342 tree: the company-2 import returned
409 and only one row existed. `npm --prefix backend run typecheck` and
`test:light` green.

**Deferred (documented).** `fabric_library` / `fabric_colours` are NOT converted:
their TEXT PKs are referenced by FOREIGN KEYS (`product_fabrics.fabric_id ->
fabric_library.id`, `fabric_colours.fabric_id -> fabric_library.id`), and the scm
DDL carrying those FKs is not in this repo (the scm schema predates the ledger), so
their existence + `product_fabrics` data-integrity cannot be verified from here.
Converting those PKs forces a drop/rebuild of an external product-catalog FK on
unverifiable prod state, so it is left for a reviewed follow-up with live prod
access. No interim data-corruption risk: the existing collision guards in
`syncFabricToSellingLibrary` report rather than re-home; the only gap is that a
second company's fabric series/colour cannot yet register in the shared selling
library (so it is not yet POS-pickable for that company). See
`docs/modules/fabric-tracking.md`.

**Ref.** feat/fabric-per-company-codes, 2026-09-02.
