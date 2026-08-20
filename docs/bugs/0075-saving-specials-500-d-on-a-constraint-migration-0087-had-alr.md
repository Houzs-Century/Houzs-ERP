## Saving Specials 500'd on a constraint migration 0087 had already replaced [high]

**Symptom** - Products -> Maintenance -> Specials, press **Save**: the panel shows
"The system hit a problem. Please try again", and the console carries
`POST /api/scm/special-addons/save 500`. Editing individual rows and creating new
ones worked; only Save failed, so the whole effective-dated Save + History mechanism
was unusable on both the Bedframe and Sofa pools.

**Root cause (traced, not guessed)** - `special-addons.ts:362` applied the snapshot
with `.upsert(upsertRows, { onConflict: 'code' })`, but
`0087_master_codes_per_company.sql` had already run:

```sql
ALTER TABLE scm.special_addons DROP CONSTRAINT IF EXISTS special_addons_code_unique;
ALTER TABLE scm.special_addons ADD CONSTRAINT special_addons_company_code_unique UNIQUE (company_id, code);
```

The single-column unique on `code` no longer exists, so PostgREST's
`ON CONFLICT (code)` has nothing to match and Postgres raises `42P10 there is no
unique or exclusion constraint matching the ON CONFLICT specification`, which the
handler wraps as `500 apply_failed`. Only `/save` uses `onConflict`; POST uses a
plain `.insert()` and PATCH an `.update()`, which is exactly why Save alone broke.
The Save feature (mig 0032) predates 0087, and nothing re-read it when the
constraint was made per-company - so this has been broken since 0087 was applied,
and stayed hidden because Save is pressed rarely. A sweep of every `onConflict` in
`backend/src` found this to be the ONLY one naming a bare `code`; the rest already
key on `id` or a `company_id,...` tuple.

**Fix** - `onConflict: 'company_id,code'`, and the handler now resolves the company
with `requireActiveCompanyId` (409 when unresolved) the way PATCH and DELETE already
do. That second half is load-bearing, not tidiness: `company_id` was previously
stamped only `if (cid != null)`, and a NULL never conflicts in a unique index - so
with the corrected `onConflict` an unresolved company would have INSERTED a second
copy of every add-on instead of updating it.

**Lesson** - **a migration that changes a unique constraint must be followed to every
`onConflict` that names it.** `ON CONFLICT` is the one place where a constraint's
exact column list is written out in application code, and nothing type-checks it
against the database.

**Ref** - `fix/special-addons-save-sort-categories`, 2026-08-12

---
