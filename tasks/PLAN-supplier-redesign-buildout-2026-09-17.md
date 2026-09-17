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
| A3 | Fabric Converter align | `FabricTracking.tsx` + `FabricsTable.tsx` (owned; NOT Products.tsx) | todo |
| B1 | Effective-dated supplier-price UI | FE dated-price UI on binding (backend exists) + read endpoint if needed | todo |
| B3 | Bulk-create importer | extend `/bindings/batch` to auto-create + preview/dry-run; `ImportBindingsDialog` | todo |
| A1 | Combo Pricing redesign | SofaComboTab FE + `sofa-combos.ts` wire derive-status/anchor/gap | todo (needs sofa-combos.ts, flagged) |

## Flags to main (judgement / ownership)
- **A2 Maintenance redesign is BLOCKED**: all rendering (`MaintenanceList`, `SpecialsMaintenancePanel`,
  `MaintenanceHistoryDialog`) lives inside `Products.tsx`, owned by another agent. Cannot do in owned files.
- **A1 Combo** needs backend enrichment in `sofa-combos.ts` (`rowToWire` lacks derive-status/anchor-supplier/gap).
  That file is not one of my 3 named files (but not a protected file either). Proceeding; flag.
- **B1 read-integration into `po-pricing.ts` deriveMfgPoUnitCost** (the money-critical as-of-date read) is
  the deliberately-staged, owner-gated step — NOT in scope here; the UI + write are.
