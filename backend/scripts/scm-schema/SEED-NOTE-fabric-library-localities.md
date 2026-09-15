# SEED FLAG — fabric_library + my_localities (2026-06-20)

Ported routes `/outstanding`, `/fabric-library` (GET list), `/localities` (GET
list) for the vendored Outstanding page, the sofa fabric-library picker, and the
SupplierDetail postcode cascade.

## Backing-table audit (READ-only introspection of the Houzs `scm` schema)

| Route                | Backing object(s)                | Exists? | Rows |
|----------------------|----------------------------------|---------|------|
| `/outstanding/*`     | `scm.v_*_outstanding` (7 views)  | YES     | live (driven by SO/PO/DO/etc. docs) |
| `/fabric-library` GET| `scm.fabric_library`             | YES     | **0 — EMPTY** (seed authored, see below) |
| `/localities` GET    | `scm.my_localities`              | YES     | **0 — EMPTY** (seed authored, see below) |

> Update 2026-06-21: both empties are now covered by the canonical seed
> `scripts/scm-schema/seed-scm-reference-data.sql` (NOT yet applied to prod).

All three backing objects ALREADY EXIST in the `scm` schema (DDL lives in
`2990s-full-schema.sql`). **No CREATE TABLE migration is needed.** Columns match
the frontend shapes verbatim:

- `fabric_library`: `id, label, tier, default_surcharge, swatch_key, active, sort_order, sofa_tier, bedframe_tier, fabric_code`
- `my_localities`: `id, postcode, city, state, state_code, country, warehouse_id`

The routes DEGRADE GRACEFULLY — empty table → `{ fabrics: [] }` / `{ localities: [] }`
(and a missing relation is also caught → `[]`), so nothing 500s.

## What returns EMPTY until seeded

1. **`/fabric-library` GET** → `[]`. Effect: ProductModelDetail's sofa
   "fabrics offered" picker renders with no options. Seeds when the Fabric
   Converter (`POST /fabric-tracking`, which upserts `fabric_library`) is used,
   or via the reference seed below.

2. **`/localities` GET** → `[]`. Effect: SupplierDetail's StateSelect falls
   back to a free-text State input (the source's verbatim no-data behaviour).

## RESOLVED — canonical reference seed authored (2026-06-21)

**Correction:** an earlier draft of this note claimed 2990 carries no
`my_localities` seed. That was wrong. 2990 ships
`packages/db/seeds/my-localities.sql` — a **2,933-row** Malaysia
State→City→Postcode dataset (source: AsyrafHussin/malaysia-postcodes, MIT). It
was simply not ported in the earlier route wave.

It is now ported, alongside the other empty reference tables, in the proper
versioned seed:

> `scripts/scm-schema/seed-scm-reference-data.sql`

That file is the LEGITIMATE, idempotent, data-only seed — the OWNER pastes it
into the Supabase SQL editor (PROD DB access is restricted here; same posture as
the sibling `sync-*.sql`). It cleans up the ad-hoc back-door stubs first, then
seeds `scm.my_localities` (2933), `scm.fabric_library` (3) + `scm.fabric_colours`
(15) + `scm.fabric_trackings` (46), `scm.so_dropdown_options` (49),
`scm.accounts` (12), `scm.categories`/`series`/`compartment_library`/
`bundle_library`/`size_library`/`addons`, and the singletons
(`delivery_fee_config`, `maintenance_config_history` baseline, `so_settings`).

Once that seed is applied:
- `/localities` GET surfaces the full postcode cascade (StateSelect leaves the
  free-text fallback).
- `/fabric-library` GET surfaces the 3 trial fabrics.

**NOT APPLIED here** — owner runs it on prod.
