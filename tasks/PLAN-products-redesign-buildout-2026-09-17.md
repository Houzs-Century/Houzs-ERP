# Products redesign buildout (2026-09-17)

Build the approved Product-Maintenance mockups into the live app. One agent owns
`Products.tsx` + `mfg-products.ts` (product / anchor / history reads). Supplier-side
files (`SupplierDetail.tsx`, `SofaComboTab`, `suppliers.ts`) belong to another agent —
route any `suppliers.ts` need through main.

Each wave = its own CI-green PR. Status kept current here per PR.

## Wave A — SKU drawer redesign (`ProductSuppliersDrawer`)
- [x] A1 Backend cost-anchor read — extend `GET /mfg-products/:id/suppliers` with
      `anchor {state, reason, anchorSupplierId, anchorSupplierName, costSen, costedCount, totalCount}`.
      Resolver `resolveProductCostAnchor` in the audited derive module; cost figure
      finance-gated. **PR #4077 — MERGED.**
- [x] A2 Backend History reads — company-scoped GET endpoints over
      `scm.mfg_product_cost_history` (`/cost-history`, Cost tab) and
      `scm.supplier_binding_price_history` (`/supplier-price-history`, Supplier-price tab,
      up/down direction via `comparableCostSen`). Selling reuses the existing price-changes read.
      **PR: feat/sku-drawer-history-reads — opening.**
- [x] A3 Frontend — Product Maintenance Cost section (`CostAnchorCard`, ok/conflict/empty/service).
      **PR: feat/sku-drawer-cost-card — opening (with A5).**
- [x] A5 Frontend — editable Category for model SKUs too (reuse `CategorySwapSelect kind="model"`
      + the existing move-the-whole-model confirmation). Standalone SKUs were already editable.
      **PR: feat/sku-drawer-cost-card.**
- [x] A4 Frontend — History block (`SkuHistoryTabs`: Cost / Selling / Supplier price, ↑/↓ arrows).
      **PR: feat/sku-drawer-history-tabs — opening.**
- [x] A6 B2 — "Add supplier binding" action from the drawer (`AddSupplierBinding`, reuses
      `useCreateBinding` -> POST /suppliers/:id/bindings; editing existing bindings stays supplier-side).
      **PR: feat/sku-drawer-add-binding — opening.**

## Wave B — SKU Master list
- [ ] B1 Cost/anchor column (teal derived / amber differ / red Gap chip), detail on click.
      Reuses the A1 anchor read.

## Wave C — sibling tabs to their mockups (align visuals, don't rebuild logic — R109)
- [ ] C1 Modular tab
- [ ] C2 Variants tab
- [ ] C3 Categories tab (stays the catalogue-category editor, owner ruling)

## Judgement calls / notes
- A1: `SERVICE` category returns `state:'service'` for DISPLAY only — it does not change
  what auto-derive writes for a service SKU that happens to carry a binding.
- A1: a zero-dearness winner (all prices blank/zero) shows as `empty / no_supplier_with_cost`,
  matching auto-derive's refusal to write an anchored RM 0.
- Mockups: match the app's real design tokens (`vendor/design-system/tokens.css`,
  `--c-success/-warn/-error`, `--font-mono`), NOT the mockup's raw CSS.
