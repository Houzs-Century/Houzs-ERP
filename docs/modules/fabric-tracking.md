# Fabric Tracking (Fabric Converter)

The fabric COST ledger and per-context price tiers. Backs the Fabric Converter table and the fabric picker on sales/consignment order lines.

## Statuses and flow

`scm.fabric_trackings` holds one cost/stock row per fabric code (`price_sen`, `soh_sen`, `po_outstanding_sen`, usage and shortage columns — snapshotted at seed time, not live-recomputed). A create or import also best-effort MIRRORS into the selling library (`scm.fabric_library` = series, `scm.fabric_colours` = colour) so the fabric becomes pickable on POS — mirror upserts are INSERT-ONLY (`ignoreDuplicates: true`) so a Master-Admin's tier edit in the selling library is never clobbered by a tracking-side write.

| Method | Path | Notes |
|---|---|---|
| GET | `/fabric-tracking` | full read (cost + stock) |
| GET | `/fabric-tracking/lite` | display/pick read — name + tiers only, no cost/stock |
| POST | `/fabric-tracking` | create one; refuses a code whose head reads as a product name |
| POST | `/fabric-tracking/bulk-upsert` | CSV import, per-column merge, per-row rejection |
| DELETE | `/fabric-tracking/:id` | scoped delete |
| PATCH | `/fabric-tracking/:id/{active,series,supplier-code,description,tier}` | inline edits |

## Permissions

- `GET /fabric-tracking` (full read) is gated on `scm.procurement.products`.
- `GET /fabric-tracking/lite` is deliberately open to the sales/consignment order-line pickers (`openReadPaths`) — it carries no cost or stock, only what's needed to pick a fabric.

## Rules that must not break

- The SCM client is service-role and bypasses RLS — the `company_id` predicate in the route is the ONLY tenant boundary (reads via `scopeToCompany`, writes via `requireActiveCompanyId` + `scopeToCompanyId`).
- `scm.fabric_trackings` is keyed PER-COMPANY (composite PK `(company_id, id)`) — two companies may legitimately hold the same fabric code as two separate rows. Never reintroduce an `onConflict: 'id'` upsert or a cross-company-refusal guard here; both were workarounds for an old global key and are now wrong.
- `scm.fabric_library`/`scm.fabric_colours` are STILL GLOBAL text keys (not yet per-company), because external foreign keys reference `fabric_library.id` from outside this repo's DDL — `syncFabricToSellingLibrary` must keep reporting a collision ("already belongs to another organisation") rather than re-homing a series/colour to a new company.
- Sofa tier is `PRICE_1`..`PRICE_4` (3 = Half Leather, 4 = Full Leather); bedframe tier stops at `PRICE_3` and the UI offers only 1 / 2. `fabric_library` (POS selling tier) stays at PRICE_3: the 2990 POS has no PRICE_4 add-on.
- A `description` PATCH must also update the mirrored `fabric_colours.label` — the colour name a salesperson actually sees comes from the selling-library mirror, not from the tracking row.

## Renaming a code

The screen shows the code as fixed text. A rename is a script, because the same string is also the price-tier join on order lines (`variants.fabricCode`), the colour inside a stock bucket (`variant_key`), an entry in a Model's fabric pool, a product request's fabric and — as its series — `variants.fabricId` and the key of an item KPI rule.

- List the pairs in `backend/scripts/data/fabric-code-renames.json`, then run `rename-fabric-codes.mjs` through "Run a backend script on production" with `BATCH=<name>` (plan first; apply needs `CONFIRM="RENAME <name>"`). One transaction, one company; a re-run is inert.
- The new code is `SERIES-NN`, and one list renames into ONE series. The row id follows the code, because the CSV import derives the id from it.
- A whole old series moves at once. Its `fabric_library` row is switched off and kept; the new series takes its tier. Series on different tiers, or with item KPI rules that pay different amounts, are refused: one series has one tier and one rule.
- Model pools get the new COLOUR codes, never the series id: the 2990 POS reads the pool as colour ids.
- Refused, not rewritten: an open cart or quote, a queued AutoCount push, `product_fabrics` rows. Audit logs, revisions and scan samples keep the old code.

## Gotchas

- A second company's fabric can land in the cost ledger while its series/colour cannot yet register in the shared selling library — it is not POS-pickable for that company until the fabric-library key is redesigned to be per-company.
- `error.code === '42501'` handling in this route is dead code (RLS is bypassed by the service-role client) — do not mistake it for a real scoping check; the `company_id` predicate is the only one that matters.
- A fabric code is refused if its head reads as a product name (e.g. starts with `SOFA`, `MATTRESS`) — this rule is duplicated in a standalone script and kept in parity by a test; change both together.

## Where the code is

- `backend/src/scm/routes/fabric-tracking.ts` — main API surface.
- `backend/src/scm/lib/companyScope.ts` — company scoping helpers.
- `backend/scripts/lib/non-fabric-code.mjs` — the parity copy of the `NON_FABRIC_HEAD` rule.
- `backend/scripts/rename-fabric-codes.mjs`, `backend/scripts/lib/fabric-code-rename.mjs` — the code rename; `lib/colour-carriers.mjs` lists every place a code is stored.
