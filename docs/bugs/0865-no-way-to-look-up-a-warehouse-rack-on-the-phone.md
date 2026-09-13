## No way to look up a warehouse rack on the phone [medium]

**Symptom.** A storekeeper standing in front of the racks could not ask the
system which rack a customer's goods were on. The desktop has three rack
surfaces — the Racks & Bins grid, the floor plan, and the cross-company view —
and the phone had none of them. The answer to 「那张沙发在哪个架？」 required
walking back to a PC.

Named by the owner's parity ruling, 2026-09-12:
「电脑版本有的，手机版本都要有」.

**Root cause (traced).** Not a broken rule — a MISSING surface, and the trace is
that `frontend/src/mobile` touched the rack API in exactly one place, and it was
a write:

```
$ git grep -n "warehouse/racks\|useRacks\|useCrossCompanyRacks" origin/main -- frontend/src/mobile
origin/main:frontend/src/mobile/MobileModuleList.tsx:980:   /warehouse/racks (warehouseId + rack label required). We pre-fill warehouseId
origin/main:frontend/src/mobile/MobileModuleList.tsx:987:  createPath: "/warehouse/racks",
```

Two hits, one of them a comment, both on the CREATE form.

`FORM_RACK` (MobileModuleList.tsx:978-995) lets a phone CREATE a rack. Nothing
read one back. `MobileApp`'s Warehouse menu group carried four rows — Warehouse,
Inventory, Stock Transfers, Stock Take — and no rack row, and
`destinationScreen` had no arm for `/scm/warehouses/racks`, so even typing the
desktop URL on a phone resolved to the "not built for phones" stub rather than
to a screen.

**Fix.** A new read-only screen, `frontend/src/mobile/MobileRacks.tsx`, plus the
menu row and the `destinationScreen` arm that reach it. It owns no rules: every
predicate comes from `frontend/src/vendor/scm/lib/warehouse-floorplan.ts` — the
same tested module the desktop `CrossCompanyRacks` reads — and the data comes
from `useCrossCompanyRacks` (`GET /warehouse/cross-company`), which scopes to the
companies the caller may see. Re-implementing any of those predicates under a
mobile name would have been invisible to `check-shared-mirrors`, which is the
drift this repo keeps paying for.

The gate is not a second rule either. The menu row points at
`/scm/warehouses/racks`, which is a live `NAV_TABS` entry in
`frontend/src/components/Sidebar.tsx` (`anyAccess: ["scm.warehouse.inventory"]`,
`hideForSalesRep: true`), so `MobileApp`'s `allowed()` resolves the phone row off
the SAME declaration that guards the desktop page.

Pinned by `frontend/src/mobile/MobileRacks.test.tsx` (11 tests). It was proved to
discriminate, not merely to pass: with `compareRackLabels` swapped for a plain
`localeCompare` the ordering test goes RED —

```
AssertionError: expected [ 'A10', 'A2' ] to deeply equal [ 'A2', 'A10' ]
```

— which is the natural-sort property a storekeeper actually needs (A2 before
A10), and it comes from the shared module rather than from this file. The error
path is pinned too: a 403 must say the read FAILED, never render an empty
warehouse.

**Not fixed here, on purpose.** Renaming, re-zoning and deleting racks stay on
the desktop Racks & Bins page. A phone in a warehouse is a finder; rack CREATE
already exists on mobile via `FORM_RACK` and is unchanged.

**Ref.** feat/mobile-parity-create-racks, 2026-09-13.
