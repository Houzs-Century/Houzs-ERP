# Fabric Tracking (Fabric Converter)

The fabric COST ledger and per-context price tiers. Backs the Fabric Converter
table and the fabric picker on sales / consignment order lines.

Route file: `backend/src/scm/routes/fabric-tracking.ts` (mounted at
`/fabric-tracking`, `backend/src/scm/index.ts`).

## What it owns

- `scm.fabric_trackings` — the cost/stock row per fabric code. Money/stock columns
  are `price_sen`, `soh_sen`, `po_outstanding_sen`, `*_usage_sen`, `shortage_sen`,
  `reorder_point_sen` (snapshotted at seed time; not live-recomputed yet).
- Best-effort MIRROR into the SELLING library (`scm.fabric_library` = series,
  `scm.fabric_colours` = colour), so a created/imported fabric is pickable on POS.
  Mirror upserts are INSERT-only (`ignoreDuplicates: true`) so a Master-Admin
  tier edit is never clobbered.

## Endpoints (surface)

| method | path | notes |
| --- | --- | --- |
| GET | `/fabric-tracking` | full read — cost + stock. Gated on `scm.procurement.products`. |
| GET | `/fabric-tracking/lite` | DISPLAY/PICK read — name + tiers only, no cost/stock. Openable to sales/consignment (`openReadPaths`). |
| POST | `/fabric-tracking` | create one. 400 `non_fabric_code` when the code opens with a product word (`NON_FABRIC_HEAD`). |
| POST | `/fabric-tracking/bulk-upsert` | CSV import. Per-column merge, per-row rejection into `errors`. |
| DELETE | `/fabric-tracking/:id` | scoped delete. |
| PATCH | `/fabric-tracking/:id/{active,series,supplier-code,description,tier}` | inline edits; `description` also updates the mirrored colour label. |

## Identity & company scope — READ BEFORE CHANGING A WRITE

- **The SCM client is service-role and bypasses RLS. The `company_id` predicate in
  the route is the ONLY tenant boundary.** Reads use `scopeToCompany`; writes use
  `requireActiveCompanyId` + `scopeToCompanyId` (see `scm/lib/companyScope.ts`).
- **`scm.fabric_trackings` is keyed PER-COMPANY: composite PRIMARY KEY
  `(company_id, id)` (migration 0342).** The `id` is the fabric code
  (`code.toUpperCase().replace(/\s+/g,'_')`). Two companies can hold the SAME code
  as two separate rows. The bulk upsert therefore conflicts on
  `company_id,id`, and there is deliberately **no** cross-company refusal — a
  shared code is a normal, separate insert. Do not reintroduce an
  `onConflict: 'id'` upsert or a `fabric_id_belongs_to_another_company` guard here;
  both were the workaround for the old global key. Pinned by
  `tests/fabricCodePerCompany.test.ts`. History: `docs/bugs/0605-*.md`.
- **`scm.fabric_library` / `scm.fabric_colours` are STILL GLOBAL TEXT keys**
  (`fabric_library.id` = series; `fabric_colours` PK `(fabric_id, colour_id)`).
  They are NOT per-company yet because external FOREIGN KEYS reference
  `fabric_library.id` (`product_fabrics.fabric_id -> fabric_library.id`, and the
  internal `fabric_colours.fabric_id -> fabric_library.id`), and the scm DDL that
  carries them is not in this repo. So `syncFabricToSellingLibrary` keeps its
  collision guards (they REPORT "series/colour already belongs to another
  organisation" rather than re-home). Consequence: a second company's fabric lands
  in the cost ledger but its series/colour cannot yet register in the shared
  selling library, so it is not yet POS-pickable for that company. Converting these
  needs a PK redesign plus a rebuild of the external FK as composite — a reviewed
  follow-up requiring live prod verification of the FK and `product_fabrics`
  integrity.

## Gotchas

- A fabric write REFUSES a code whose head reads as a product (`SOFA`, `SQUARE
  PILLOW`, `MATTRESS`, ...). Rule is `NON_FABRIC_HEAD`, code-only, head-only. Kept
  identical to `scripts/lib/non-fabric-code.mjs` by `nonFabricCodeParity.test.ts`.
- `error.code === '42501'` handling is a DEAD branch (RLS bypassed by service-role);
  it is NOT a scoping check.
- The `description` PATCH must also update the mirrored `fabric_colours.label` —
  the colour NAME a salesperson sees comes from the mirror, not from here.
