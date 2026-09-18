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
- A `description` PATCH must also update the mirrored `fabric_colours.label` — the colour name a salesperson actually sees comes from the selling-library mirror, not from the tracking row.

## Gotchas

- A second company's fabric can land in the cost ledger while its series/colour cannot yet register in the shared selling library — it is not POS-pickable for that company until the fabric-library key is redesigned to be per-company.
- `error.code === '42501'` handling in this route is dead code (RLS is bypassed by the service-role client) — do not mistake it for a real scoping check; the `company_id` predicate is the only one that matters.
- A fabric code is refused if its head reads as a product name (e.g. starts with `SOFA`, `MATTRESS`) — this rule is duplicated in a standalone script and kept in parity by a test; change both together.

## Where the code is

- `backend/src/scm/routes/fabric-tracking.ts` — main API surface.
- `backend/src/scm/lib/companyScope.ts` — company scoping helpers.
- `backend/scripts/lib/non-fabric-code.mjs` — the parity copy of the `NON_FABRIC_HEAD` rule.
