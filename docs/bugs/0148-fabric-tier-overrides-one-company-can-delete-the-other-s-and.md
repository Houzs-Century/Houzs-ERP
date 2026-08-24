## Fabric-tier overrides: one company can delete the other's, and overwrite it [medium]

**Symptom** - a model's fabric-tier delta reverts to the global value with no edit
behind it, so the SO recompute quietly prices the model differently.

**Root cause** - `DELETE /special/:modelId` and
`DELETE /compartment-special/:compartmentId` in `routes/fabric-tier-addon.ts`
filtered on the id alone, while the sibling GETs use `scopeToCompany` and both
tables carry `company_id NOT NULL` (mig 0083). Same class as the sofa-combo and
model-free-gift deletes fixed in the same pass.

**Fix** - both deletes wrapped in `scopeToCompany`.

**KNOWN AND NOT FIXED, deliberately** - the PK of both tables is the single
business column (`model_id`, `2990s-full-schema.sql:770`; `compartment_id text
PRIMARY KEY`, mig 0025:11). Mig 0083 added `company_id` and left both keys alone,
so each table can hold only ONE row per model/compartment across all companies and
the upsert (`onConflict: 'model_id'` / `'compartment_id'`) overwrites whichever
company saved first — the same shape as the POS-cart entry above. Scoping the
delete cannot fix that. Making it `(company_id, model_id)` is a migration AND a
business question (does Houzs want per-company fabric-tier deltas at all, or is
one shared table the intent?), so it is recorded here for the owner rather than
changed unilaterally.

**Both halves of that paragraph were overtaken, same branch — read it as
history.** The two tables looked identical and are not, and telling them apart
needed the PARENT table, not the child's column list.

- COMPARTMENT: real, and now closed. Mig `0287_scm_compartment_tier_override_company_key.sql` [renumbered]
  re-keys `scm.compartment_fabric_tier_overrides` to `(compartment_id,
  company_id)`, and the PUT moved to `onConflict: 'compartment_id,company_id'`
  in the same change (`fabric-tier-addon.ts:274`) — the constraint and the
  caller's `onConflict` must move together or every save is a `42P10`, the
  `special_addons` lesson below. It was NOT an owner question: the same file
  already scoped the GET by company, so the intent was on record and only the
  key was the leftover.
- MODEL: not a defect at all. `product_models` itself carries `company_id` —
  rows are created with `company_id: activeCompanyId(c)`
  (`product-models.ts:445`) and listed through `scopeToCompany` (`:181`) — so
  each company owns its own model rows with their own uuids and two companies
  can never contend for one `model_id`. A key of `(model_id)` already implies a
  company. `onConflict: 'model_id'` therefore still stands at
  `fabric-tier-addon.ts:155`, deliberately; the retraction is written into the
  route at `:173-192`.

Open, and unsettled from source: mig 0293's header justifies itself with
"`scm.compartment_library` carries NO `company_id`", and mig 0089:74 stamps
`company_id` on that very table (NOT NULL, FK, index). 0089's own header says the
text PK was left alone so "a 2990 import must use ids distinct from Houzs's".
Whether the two companies actually share compartment ids in production is a data
question this audit could not answer, so the re-key is at worst a harmless
widening — but the stated reason for it does not match the DDL.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
