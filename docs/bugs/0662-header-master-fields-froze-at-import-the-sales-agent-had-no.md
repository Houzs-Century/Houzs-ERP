## Header master fields froze at import: the sales agent had no cutover tool at all [high]

**Symptom.** A migrated sales order shows the customer, the address and the
salesperson AutoCount had on the day we copied it, not the ones AutoCount has
today. Nothing in the repo could even count how many. The cutover census in
`docs/golive-runbook-2026-09-07.md` (PR #3050 / #3054) recorded it in one line:
*"Sales agent has no cutover tool at all."*

**Root cause (traced).** `backend/scripts/import-ac-outstanding-so.mjs` maps
AutoCount's header onto the ERP's columns in exactly one place — the
`HCOLS` / `hv.push(...)` block that builds the INSERT — and its header states the
document's own idempotency rule: `INSERT ... ON CONFLICT (doc_no) DO NOTHING`,
with *"items and payments written only for a NEWLY inserted header"*. So a
re-run brings in NEW documents and touches no already-migrated one, by design.
`sync-ac-delta.mjs` closed that hole for LINE text, MONEY and LINKS and left the
HEADER out of scope entirely — its own lane table names an owner for remarks,
variants, photos and compartments, and none for `agent`, `debtor_name`,
`address1..4`, `phone`, `ref`, `venue` or `branding`.

The agent is the sharpest case because the import can also CREATE master data
for it: `resolveSalesperson` reads `data/agent-staff-binding.csv`, and an agent
marked for creation gets a new `scm.staff` row with an `ACIMP-` code and
`active=false`. The 2026-09-07 dry run printed `staff to auto-create (inactive
salesperson): 22`. Nothing since has asked whether AutoCount now spells that
agent differently, or whether a REAL staff row has appeared for a name we
invented a placeholder for.

**Fix.** The header map moves out of the importer into one shared declaration,
`backend/scripts/lib/ac-header-fields.mjs`, which the importer and
`sync-ac-delta.mjs` both read — a second copy of an import rule is this repo's
most expensive recurring bug, so `SALESLOC` was MOVED rather than copied and a
test fails if the importer grows a local one again. `sync-ac-delta.mjs` gains a
header-master section that reports, per FIELD, how many migrated documents
agree, differ, or are blank in the ERP while AutoCount has a value, plus the
sales-agent reconciliation; `LANES=hdr` writes the straight copies and
`LANES=hdrstaff` creates the missing inactive staff rows. Both are off by
default. `export-ac-reimport.py` gains an additive `hdr` section
(`ac-doc-headers.json.gz`) because the existing cut is filtered to the
OUTSTANDING population and carries none of the fields no importer read.

Three rules are pinned by `backend/scripts/lib/ac-header-fields.test.mjs`. They
were proved RED by breaking the map deliberately — adding a `version` needle,
making `writeValue` return the flattened form, turning `bookBlank` into
`differ`, and re-adding a local `SALESLOC` to the importer — which failed
exactly those four tests (`tests 13 / pass 9 / fail 4`) and no others; the tree
was then restored and all 13 pass:

- COPY, NEVER COMPUTE — a blank book value yields `bookBlank` and never a write,
  and `writeValue` returns AutoCount's own text, never the flattened comparison
  form. A `derive` field (postcode, city, state, emergency phone) is reported
  and never written: re-deriving it is the inference
  `migration-copy-never-compute` forbids.
- The human veto contains no `version` needle. `check-so-version-provenance.mjs`
  (PR #3042) measured 80 of 81 `sync-ac-delta` "conflicts" as the automated
  stock-allocation sweep and exactly 1 as a person, so the header lane refuses
  per (document, FIELD) on `mfg_so_audit_log.actor_id` being a real person
  instead. The plan prints what a `version > 1` arm WOULD have refused so the
  difference is a number.
- Every field with an ERP column contributes its own audit needle, derived from
  the map — a field cannot be added without its veto.

Two smaller defects fixed in passing, both in `export-ac-reimport.py`:
`ONLY=<section>` REPLACED `ac-reimport-manifest.json` from whatever that
invocation touched, deleting the receipts of every section with no reload branch
(ruler, remarks, stamps); the manifest is now merged. And `exported_at` was
restamped by a run that re-cut none of the files it dates, so it is now
preserved unless a manifest-recorded section actually ran, with a `last_run`
field recording the rest.

**Ref.** feat/ac-header-master-sync, 2026-09-07.
