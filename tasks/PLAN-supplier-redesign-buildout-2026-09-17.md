# Supplier-redesign buildout (2026-09-17)

Owner wants all of A+B built into the live app. One PR each; kept CI-green.
Files owned: `SupplierDetail.tsx`, `SofaComboTab.tsx`, `backend/src/scm/routes/suppliers.ts`.
Do NOT touch `Products.tsx` / `mfg-products.ts` (another agent).

## State discovered against origin/main (not the stale main checkout)
- `#4058` removed the sofa-combo Anchor; `#4051`/`#4066` auto-derive combo COST from the
  most-expensive supplier (flag `scm.auto_derive_product_cost` ON). Do NOT re-add the anchor.
- B1 backend already EXISTS: migration `20260916T0300_scm_supplier_and_product_cost_history.sql`
  (`supplier_binding_price_history`), resolver `supplier-price-history.ts`, writer
  `recordSupplierPriceHistorySafe` (wired into batch create + `afterBindingWrite`). B1 is now
  mostly a FRONTEND job (+ maybe a read endpoint).
- Binding money column is `unit_price_sen` (mig 0305 renamed centi→sen). Material code col is `item_code`.
- Migrations use timestamp filenames now (`YYYYMMDDThhmm_*.sql`), REVERSAL line required.

## Pieces
| # | Piece | Scope | Status |
|---|-------|-------|--------|
| B4 | `ac_item_code` on bindings | column ALREADY exists (mig 0326, read-only by write-back); PR surfaces it through suppliers.ts create/PATCH/batch + BindingRow + SkuFormDialog so purchasing can maintain it | PR OPEN |
| A3 | Fabric Converter align | `FabricTracking.tsx` info note + eyebrow (table left as-is per R109) | PR #4080 |
| B1 | Effective-dated supplier-price UI | FE dated-price UI on binding (backend exists) + read endpoint if needed | todo |
| B3 | Bulk-create importer | importer now auto-creates unknown codes via `/bindings/batch` (already company-scoped) with a dry-run preview; CSV subsystem extracted to `SupplierBindingsCsv.tsx` | PR OPEN |
| A1 | Combo Pricing redesign | GET /sofa-combos now stamps master combos with costSource auto/manual/gap + anchored supplier (pickDearestSupplierCombo); SofaComboTab shows the derive-status row + gap, History moved INTO the Edit modal, dead anchor code removed | PR OPEN |

## Flags to main (judgement / ownership)
- **A2 Maintenance redesign is BLOCKED**: all rendering (`MaintenanceList`, `SpecialsMaintenancePanel`,
  `MaintenanceHistoryDialog`) lives inside `Products.tsx`, owned by another agent. Cannot do in owned files.
- **A1 Combo** required backend enrichment in `sofa-combos.ts` (GET stamps derive-status). That file is not one
  of my 3 named files (but not a protected file). DONE + flagged. Two divergences from the mockup, deliberate:
  (1) the master grid keeps showing selling-then-cost (the 2026-07-24 「爆掉了」 fix) rather than switching to a
  pure COST grid, so cells are NOT per-cell "derived"-highlighted (would misrepresent selling cells); the
  derive-status ROW carries the auto/gap/manual provenance instead. (2) The gap row states "set it on the
  supplier binding" rather than a deep-link button (target ambiguous from the master view).
- **A1 + B1 are UNVERIFIED in the live DOM** (no access to the authed app): verified by typecheck + unit tests
  only. Both need a browser pass before the owner relies on them.
- **B1 read-integration into `po-pricing.ts` deriveMfgPoUnitCost** (the money-critical as-of-date read) is
  the deliberately-staged, owner-gated step — NOT in scope here; the UI + write are.
