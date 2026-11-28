export * from './phone';
export * from './maintenance-pools';
export * from './format';
export * from './variant-summary';
export * from './effective-delivery';
export * from './adjustment-reasons';
export * from './so-variant-rule';
export * from './inventory-adjustment';
export * from './variant-key';
export * from './sofa-build';
export * from './sofa-default-layout';
export * from './sofa-quick-presets';
export * from './sofa-tier';
export { buildComboLabel, comboSlotsKey, type SofaPriceTier } from './sofa-combo-pricing';
// Multi-currency / landed-cost wave (Phase 1-A FX) — GrnNew / PurchaseInvoiceNew
// split a SERVICE freight ("平摊") line's charge across the goods lines; the
// allocation preview needs the SERVICE-line predicate. Verbatim from 2990's
// packages/shared/src/service-sku.ts.
export * from './service-sku';
export * from './costing-enabled';
export * from './line-identity';
