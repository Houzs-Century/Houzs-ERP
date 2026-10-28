// Vendored subset of @2990s/shared — only the modules the SCM slices
// transitively need. The real package re-exports ~24 modules (pricing,
// sofa-build, schemas, …); those are not pulled in by these slices. When the
// next pages need more, add the module file here + extend this barrel.
//
// NOTE: mfg-pricing is NOT re-exported here — the PO pages import it via the
// dedicated subpath `@2990s/shared/mfg-pricing` (its own alias), matching the
// source. Barreling it would also collide its `MaintenanceConfig` export with
// the one in mfg-products-queries.
export * from './phone';
export * from './maintenance-pools';
export * from './format';
export * from './variant-summary';
// PDF wave — the real purchase-order-pdf imports effectiveDelivery (the
// "latest revised delivery date" helper) via the @2990s/shared barrel.
export * from './effective-delivery';
// Stock-movements wave (Stock Adjustments / Transfers / Takes).
export * from './adjustment-reasons';
export * from './so-variant-rule';
export * from './inventory-adjustment';
// Inventory / StockCard wave — formatVariantKey for the stock-bucket display.
export * from './variant-key';
// Products wave — sofa configurator catalogue + combo/preset/tier helpers the
// Products page, SofaComboTab and the sofa-combos query layer read. sofa-build
// already re-exports SofaComboRow + comboChargedPrices from sofa-combo-pricing,
// so the latter is NOT star-exported here (that would make those two names
// ambiguous). The two symbols only sofa-combo-pricing carries that consumers
// need — SofaPriceTier (type) + buildComboLabel — are re-exported by name.
export * from './sofa-build';
export * from './sofa-default-layout';
export * from './sofa-quick-presets';
export * from './sofa-tier';
export { buildComboLabel, type SofaPriceTier } from './sofa-combo-pricing';
// Multi-currency / landed-cost wave (Phase 1-A FX) — GrnNew / PurchaseInvoiceNew
// split a SERVICE freight ("平摊") line's charge across the goods lines; the
// allocation preview needs the SERVICE-line predicate. Verbatim from 2990's
// packages/shared/src/service-sku.ts.
export * from './service-sku';
// The ONE switch for cost/margin DISPLAY. Off while the Houzs catalog carries
// no costs — see costing-enabled.ts for why, and for what turns it back on.
export * from './costing-enabled';
// The ONE rule for "how a document line NAMES itself" — description ONCE, the
// redundant item code NOT displayed, the variant KEPT. Barrelled (not a
// subpath) so a new surface reaches it from the same `@2990s/shared` import it
// already has for buildVariantSummary — the rule should be easier to find than
// to re-invent. See line-identity.ts for the four-report history behind it.
export * from './line-identity';
